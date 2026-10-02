import express, { Router, type IRouter, type Request, type Response } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  CreateModelExportBody,
  CreateModelExportParams,
  CreateModelExportResponse,
  CreateReconstructionTaskBody,
  CreateReconstructionTaskResponse,
  DownloadReconstructionModelParams,
  GetReconstructionTaskParams,
  GetReconstructionTaskResponse,
  UploadReconstructionImageResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const connectors = new ReplitConnectors();
const provider = "tripo3d";
const maxImageBytes = 20 * 1024 * 1024;
const acceptedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const acceptedRequestTypes = [...acceptedImageTypes, "application/octet-stream"];
const activeStatuses = new Set(["queued", "running"]);
const finalStatuses = new Set([
  "success",
  "failed",
  "banned",
  "expired",
  "cancelled",
]);

interface TaskEntry {
  createdAt: number;
  kind: "reconstruction" | "export";
  format: string;
  modelUrl?: string;
}

interface TripoEnvelope {
  code?: number;
  message?: string;
  suggestion?: string;
  data?: Record<string, unknown>;
}

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerCode: number | undefined,
    readonly traceId: string | undefined,
  ) {
    super(message);
  }

  get clientStatus(): number {
    if (this.providerCode === 2010) return 402;
    if (this.status === 429 || this.providerCode === 1007 || this.providerCode === 2000) {
      return 429;
    }
    return 502;
  }
}

const tasks = new Map<string, TaskEntry>();

function pruneTasks(): void {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [taskId, entry] of tasks) {
    if (entry.createdAt < cutoff) tasks.delete(taskId);
  }
  while (tasks.size > 100) {
    const oldest = tasks.keys().next().value;
    if (!oldest) break;
    tasks.delete(oldest);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function tripoRequest(
  path: string,
  options: { method: "GET" | "POST"; body?: FormData | string },
): Promise<Record<string, unknown>> {
  const response = await connectors.proxy(provider, path, {
    method: options.method,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(typeof options.body === "string"
      ? { headers: { "Content-Type": "application/json" } }
      : {}),
  });

  const payload = (await response.json().catch(() => null)) as TripoEnvelope | null;
  if (
    !response.ok ||
    payload?.code !== 0 ||
    !isRecord(payload.data)
  ) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : `Tripo3D returned HTTP ${response.status}.`;
    throw new ProviderError(
      payload?.suggestion ? `${message} ${payload.suggestion}` : message,
      response.status,
      typeof payload?.code === "number" ? payload.code : undefined,
      response.headers.get("x-tripo-trace-id") ?? undefined,
    );
  }

  return payload.data;
}

function sendError(req: Request, res: Response, error: unknown): void {
  if (error instanceof ProviderError) {
    req.log.warn(
      {
        providerStatus: error.status,
        providerCode: error.providerCode,
        traceId: error.traceId,
      },
      "Tripo3D request failed",
    );
    res.status(error.clientStatus).json({ error: error.message });
    return;
  }

  req.log.error({ err: error }, "3D reconstruction request failed");
  res.status(500).json({ error: "The 3D request could not be completed." });
}

function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") return "running";
  if (activeStatuses.has(value) || finalStatuses.has(value)) return value;
  if (value === "in_progress" || value === "processing") return "running";
  return "running";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sniffImageType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function getTaskResult(taskId: string) {
  const entry = tasks.get(taskId);
  if (!entry) return null;

  const data = await tripoRequest(`/task/${encodeURIComponent(taskId)}`, {
    method: "GET",
  });
  const status = normalizeStatus(data.status);
  const progress =
    typeof data.progress === "number" && Number.isFinite(data.progress)
      ? Math.max(0, Math.min(100, Math.floor(data.progress)))
      : status === "success"
        ? 100
        : 0;
  const output = isRecord(data.output) ? data.output : null;
  const reportedModelUrl = nullableString(output?.model);
  if (reportedModelUrl) entry.modelUrl = reportedModelUrl;

  let message =
    nullableString(data.message) ??
    nullableString(data.error_message) ??
    nullableString(data.suggestion);
  let visibleStatus = status;

  if (status === "success" && !entry.modelUrl) {
    visibleStatus = "failed";
    message = "The provider finished without returning a downloadable model.";
  }

  return GetReconstructionTaskResponse.parse({
    taskId,
    status: visibleStatus,
    progress: visibleStatus === "success" ? 100 : progress,
    modelPath:
      visibleStatus === "success"
        ? `/api/reconstruction/tasks/${encodeURIComponent(taskId)}/file`
        : null,
    message,
  });
}

router.post(
  "/reconstruction/images",
  express.raw({
    type: acceptedRequestTypes,
    limit: maxImageBytes,
  }),
  async (req, res): Promise<void> => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "The image upload is empty or invalid." });
      return;
    }
    if (req.body.length > maxImageBytes) {
      res.status(413).json({ error: "Images must be 20 MB or smaller." });
      return;
    }

    const requestType = req.get("content-type")?.split(";")[0]?.toLowerCase();
    const detectedType = sniffImageType(req.body);
    const contentType =
      requestType && acceptedImageTypes.has(requestType)
        ? requestType
        : requestType === "application/octet-stream"
          ? detectedType
          : null;
    if (!contentType || !acceptedImageTypes.has(contentType) || !detectedType) {
      res.status(400).json({ error: "Upload a valid PNG, JPEG, or WebP image." });
      return;
    }
    if (contentType !== detectedType) {
      res.status(400).json({ error: "The image content does not match its file type." });
      return;
    }

    try {
      const extension =
        contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
      const image = new Blob([Uint8Array.from(req.body)], { type: contentType });
      const form = new FormData();
      form.append("file", image, `vision2mesh-input.${extension}`);
      const data = await tripoRequest("/upload/sts", {
        method: "POST",
        body: form,
      });

      if (typeof data.image_token !== "string") {
        throw new Error("Tripo3D did not return an image token.");
      }
      pruneTasks();
      res
        .status(201)
        .json(UploadReconstructionImageResponse.parse({ imageToken: data.image_token }));
    } catch (error) {
      sendError(req, res, error);
    }
  },
);

router.post("/reconstruction/tasks", async (req, res): Promise<void> => {
  const parsed = CreateReconstructionTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { mode, imageTokens } = parsed.data;
  if (mode === "scan" && imageTokens.length !== 4) {
    res.status(400).json({
      error: "A 3D scan needs four images in front, left, back, and right order.",
    });
    return;
  }
  if (mode !== "scan" && imageTokens.length !== 1) {
    res.status(400).json({ error: "This mode accepts one source image." });
    return;
  }

  try {
    const body =
      mode === "scan"
        ? {
            type: "multiview_to_model",
            files: imageTokens.map((file_token) => ({
              type: "image",
              file_token,
            })),
          }
        : {
            type: "image_to_model",
            file: { type: "image", file_token: imageTokens[0] },
          };
    const data = await tripoRequest("/task", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (typeof data.task_id !== "string") {
      throw new Error("Tripo3D did not return a task ID.");
    }

    pruneTasks();
    tasks.set(data.task_id, {
      createdAt: Date.now(),
      kind: "reconstruction",
      format: "GLTF",
    });
    res
      .status(202)
      .json(
        CreateReconstructionTaskResponse.parse({
          taskId: data.task_id,
          status: "queued",
          progress: 0,
          modelPath: null,
          message: null,
        }),
      );
  } catch (error) {
    sendError(req, res, error);
  }
});

router.get("/reconstruction/tasks/:taskId", async (req, res): Promise<void> => {
  const params = GetReconstructionTaskParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const task = await getTaskResult(params.data.taskId);
    if (!task) {
      res.status(404).json({ error: "This task is no longer available in this session." });
      return;
    }
    res.json(task);
  } catch (error) {
    sendError(req, res, error);
  }
});

router.post(
  "/reconstruction/tasks/:taskId/exports",
  async (req, res): Promise<void> => {
    const params = CreateModelExportParams.safeParse(req.params);
    const body = CreateModelExportBody.safeParse(req.body);
    if (!params.success || !body.success) {
      const message = !params.success
        ? params.error.message
        : body.success
          ? "Invalid format."
          : body.error.message;
      res.status(400).json({ error: message });
      return;
    }

    try {
      const originalTask = tasks.get(params.data.taskId);
      if (!originalTask || originalTask.kind !== "reconstruction") {
        res.status(404).json({ error: "The source model is no longer available." });
        return;
      }

      const latest = await getTaskResult(params.data.taskId);
      if (!latest || latest.status !== "success") {
        res.status(409).json({ error: "Wait for the original model to finish first." });
        return;
      }

      const data = await tripoRequest("/task", {
        method: "POST",
        body: JSON.stringify({
          type: "convert_model",
          original_model_task_id: params.data.taskId,
          format: body.data.format,
        }),
      });
      if (typeof data.task_id !== "string") {
        throw new Error("Tripo3D did not return a format-conversion task ID.");
      }

      tasks.set(data.task_id, {
        createdAt: Date.now(),
        kind: "export",
        format: body.data.format,
      });
      res
        .status(202)
        .json(
          CreateModelExportResponse.parse({
            taskId: data.task_id,
            status: "queued",
            progress: 0,
            modelPath: null,
            message: null,
          }),
        );
    } catch (error) {
      sendError(req, res, error);
    }
  },
);

router.get(
  "/reconstruction/tasks/:taskId/file",
  async (req, res): Promise<void> => {
    const params = DownloadReconstructionModelParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    try {
      const result = await getTaskResult(params.data.taskId);
      const entry = tasks.get(params.data.taskId);
      if (!result || result.status !== "success" || !entry?.modelUrl) {
        res.status(409).json({ error: "The generated model file is not ready." });
        return;
      }

      // Tripo's signed result URLs expire quickly, so always fetch the newest URL
      // returned by the task status endpoint before serving a model to the viewer.
      const fileResponse = await fetch(entry.modelUrl);
      if (!fileResponse.ok) {
        res.status(502).json({ error: "The model download has expired; refresh the task and try again." });
        return;
      }

      const file = Buffer.from(await fileResponse.arrayBuffer());
      const extension =
        entry.format === "GLTF" ? "glb" : entry.format.toLowerCase();
      res
        .status(200)
        .setHeader("Content-Type", "application/octet-stream")
        .setHeader(
          "Content-Disposition",
          `attachment; filename="vision2mesh-model.${extension}"`,
        )
        .setHeader("Content-Length", file.length)
        .send(file);
    } catch (error) {
      sendError(req, res, error);
    }
  },
);

export default router;