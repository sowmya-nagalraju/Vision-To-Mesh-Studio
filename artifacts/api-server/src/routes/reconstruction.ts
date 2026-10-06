import express, { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
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
import { glbToTriMesh, objToGlb, toObj, toStl } from "../lib/glbConvert";
import { generateViaHttp } from "../lib/gradioHttp";

/**
 * Free, open-source image -> 3D backend (no paid credits).
 * Runs TripoSR on a Hugging Face Space through the Gradio API.
 *
 * Optional environment variables (Replit "Secrets"):
 *   HF_TOKEN       Free Hugging Face token (hf_...). Strongly recommended: gives a larger GPU quota.
 *   MESH_SPACE     Space(s) to call, comma-separated, tried in order. Default: gdTharusha/3D-Modle-Generator,stabilityai/TripoSR
 *   MESH_REMOVE_BG "true"/"false" - remove background before reconstruction. Default: true
 *   MESH_RESOLUTION Marching-cubes resolution (32-320). Default: 128 (faster on free servers)
 */
const router: IRouter = Router();
// Comma-separated list of Spaces, tried in order until one works.
const SPACES = (process.env["MESH_SPACE"] ?? "gdTharusha/3D-Modle-Generator,stabilityai/TripoSR")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const RAW_TOKEN = process.env["HF_TOKEN"];
const HF_TOKEN = RAW_TOKEN && /^hf_[A-Za-z0-9]{20,}$/.test(RAW_TOKEN) ? (RAW_TOKEN as `hf_${string}`) : undefined;
if (RAW_TOKEN && !HF_TOKEN) console.warn("[reconstruction] HF_TOKEN does not look like a real Hugging Face token and was ignored.");
const RESOLUTION = Number(process.env["MESH_RESOLUTION"] ?? 128);
const REMOVE_BG_DEFAULT = (process.env["MESH_REMOVE_BG"] ?? "true") !== "false";

const maxImageBytes = 20 * 1024 * 1024;
const acceptedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const acceptedRequestTypes = [...acceptedImageTypes, "application/octet-stream"];

type Status = "queued" | "running" | "success" | "failed";

interface TaskEntry {
  createdAt: number;
  kind: "reconstruction" | "export";
  format: string;
  status: Status;
  progress: number;
  message: string | null;
  glb?: Buffer;
  sourceTaskId?: string;
}

interface StoredImage {
  createdAt: number;
  buffer: Buffer;
  contentType: string;
}

const tasks = new Map<string, TaskEntry>();
const images = new Map<string, StoredImage>();

function prune(): void {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, t] of tasks) if (t.createdAt < cutoff) tasks.delete(id);
  for (const [id, i] of images) if (i.createdAt < cutoff) images.delete(id);
  while (tasks.size > 30) {
    const oldest = tasks.keys().next().value;
    if (!oldest) break;
    tasks.delete(oldest);
  }
  while (images.size > 40) {
    const oldest = images.keys().next().value;
    if (!oldest) break;
    images.delete(oldest);
  }
}

function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function friendlyError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  if (/quota|exceeded|too many requests|429/i.test(raw)) {
    return "The free GPU quota on Hugging Face is used up for now. Add a free HF_TOKEN in Secrets for a bigger quota, or retry in a few minutes.";
  }
  if (/resolve app config|runtime error|not found|404|no 3d model server/i.test(raw)) {
    return "The free 3D model server (a Hugging Face Space) is down or has moved. Details: " + raw;
  }
  if (/sleep|building|starting|paused/i.test(raw)) {
    return "The free 3D model server is waking up or unavailable. Wait a minute and try again.";
  }
  if (/timed out/i.test(raw)) return raw;
  return raw && raw !== "undefined" ? raw : "The 3D model server did not return a result.";
}


async function runReconstruction(taskId: string, image: StoredImage, removeBg: boolean): Promise<void> {
  const entry = tasks.get(taskId);
  if (!entry) return;
  const baseMessage = entry.message;
  try {
    entry.status = "running";
    entry.progress = 5;
    const failures: string[] = [];
    for (const space of SPACES) {
      const log = (m: string) => console.log(`[reconstruction] ${space} ${m}`);
      let lastRaw = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) {
            entry.message = `The free server dropped the connection. Retrying (${attempt} of 3)`;
            entry.progress = 8;
            log(`retry ${attempt}`);
          }
          const out = await generateViaHttp({
            space,
            image: image.buffer,
            contentType: image.contentType,
            removeBg,
            foregroundRatio: 0.8,
            resolution: RESOLUTION,
            token: HF_TOKEN,
            preprocessTimeoutMs: 5 * 60 * 1000,
            generateTimeoutMs: 25 * 60 * 1000,
            onStatus: (progress, message) => {
              entry.progress = progress;
              entry.message = message;
            },
            log,
          });
          entry.glb = /\.obj$/i.test(out.fileName) ? objToGlb(out.data) : out.data;
          entry.message = baseMessage;
          entry.status = "success";
          entry.progress = 100;
          return;
        } catch (error) {
          lastRaw = error instanceof Error ? error.message : String(error);
          console.error(`[reconstruction] ${space} attempt ${attempt} failed: ${lastRaw}`);
          if (!/terminated|fetch failed|socket|closed|reset|ECONN|network|stream ended/i.test(lastRaw)) break;
        }
      }
      failures.push(`${space}: ${lastRaw}`);
    }
    throw new Error(`No 3D model server is available right now. ${failures.join(" | ")}`);
  } catch (error) {
    entry.status = "failed";
    entry.message = friendlyError(error);
  }
}

// When running on your own computer the page (port 25720) and the API (port 8080) are different
// addresses, so the model address must be absolute or the 3D preview would ask the wrong server.
function baseOf(req: Request): string {
  const host = req.get("host") ?? "";

  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    return `${req.protocol}://${host}`;
  }

  return `${req.protocol}://${host}`;
}

function view(taskId: string, entry: TaskEntry, base = "") {
  return {
    taskId,
    status: entry.status,
    progress: entry.status === "success" ? 100 : entry.progress,
    modelPath: entry.status === "success" ? `${base}/api/reconstruction/tasks/${encodeURIComponent(taskId)}/file` : null,
    message: entry.message,
  };
}

function sendError(req: Request, res: Response, error: unknown): void {
  req.log.error({ err: error }, "3D reconstruction request failed");
  res.status(500).json({ error: friendlyError(error) });
}

router.post(
  "/reconstruction/images",
  express.raw({ type: acceptedRequestTypes, limit: maxImageBytes }),
  async (req, res): Promise<void> => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "The image upload is empty or invalid." });
      return;
    }
    const requestType = req.get("content-type")?.split(";")[0]?.toLowerCase();
    const detectedType = sniffImageType(req.body);
    if (!detectedType) {
      res.status(400).json({ error: "Upload a valid PNG, JPEG, or WebP image." });
      return;
    }
    if (requestType && acceptedImageTypes.has(requestType) && requestType !== detectedType) {
      res.status(400).json({ error: "The image content does not match its file type." });
      return;
    }
    prune();
    const imageToken = randomUUID();
    images.set(imageToken, { createdAt: Date.now(), buffer: Buffer.from(req.body), contentType: detectedType });
    res.status(201).json(UploadReconstructionImageResponse.parse({ imageToken }));
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
    res.status(400).json({ error: "A 3D scan needs four images in front, left, back, and right order." });
    return;
  }
  if (mode !== "scan" && imageTokens.length !== 1) {
    res.status(400).json({ error: "This mode accepts one source image." });
    return;
  }
  // TripoSR is single-image: for a 4-view scan the front view (first image) is used.
  const image = images.get(imageTokens[0]!);
  if (!image) {
    res.status(404).json({ error: "The uploaded image expired. Please add it again." });
    return;
  }
  try {
    prune();
    const taskId = randomUUID();
    const entry: TaskEntry = {
      createdAt: Date.now(),
      kind: "reconstruction",
      format: "GLTF",
      status: "queued",
      progress: 0,
      message: mode === "scan" ? "Using the front view for this free model." : null,
    };
    tasks.set(taskId, entry);
    void runReconstruction(taskId, image, mode === "blueprint" ? false : REMOVE_BG_DEFAULT);
    res.status(202).json(CreateReconstructionTaskResponse.parse(view(taskId, entry, baseOf(req))));
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
  const entry = tasks.get(params.data.taskId);
  if (!entry) {
    res.status(404).json({ error: "This task is no longer available in this session." });
    return;
  }
  res.json(GetReconstructionTaskResponse.parse(view(params.data.taskId, entry, baseOf(req))));
});

router.post("/reconstruction/tasks/:taskId/exports", async (req, res): Promise<void> => {
  const params = CreateModelExportParams.safeParse(req.params);
  const body = CreateModelExportBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.success ? "Invalid format." : body.error.message });
    return;
  }
  const source = tasks.get(params.data.taskId);
  if (!source || source.kind !== "reconstruction") {
    res.status(404).json({ error: "The source model is no longer available." });
    return;
  }
  if (source.status !== "success" || !source.glb) {
    res.status(409).json({ error: "Wait for the original model to finish first." });
    return;
  }
  const format = body.data.format;
  if (!["GLTF", "OBJ", "STL"].includes(format)) {
    res.status(400).json({ error: `${format} export is not available in the free version. Use GLTF, OBJ, or STL.` });
    return;
  }
  const exportId = randomUUID();
  const entry: TaskEntry = {
    createdAt: Date.now(),
    kind: "export",
    format,
    status: "success",
    progress: 100,
    message: null,
    sourceTaskId: params.data.taskId,
  };
  tasks.set(exportId, entry);
  res.status(202).json(CreateModelExportResponse.parse(view(exportId, entry, baseOf(req))));
});

router.get("/reconstruction/tasks/:taskId/file", async (req, res): Promise<void> => {
  const params = DownloadReconstructionModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const entry = tasks.get(params.data.taskId);
  const source = entry?.kind === "export" ? tasks.get(entry.sourceTaskId ?? "") : entry;
  if (!entry || !source?.glb || source.status !== "success") {
    res.status(409).json({ error: "The generated model file is not ready." });
    return;
  }
  try {
    let file: Buffer;
    let extension: string;
    if (entry.format === "OBJ") {
      file = toObj(glbToTriMesh(source.glb));
      extension = "obj";
    } else if (entry.format === "STL") {
      file = toStl(glbToTriMesh(source.glb));
      extension = "stl";
    } else {
      file = source.glb;
      extension = "glb";
    }
    res
      .status(200)
      .setHeader("Content-Type", "application/octet-stream")
      .setHeader("Content-Disposition", `attachment; filename="vision2mesh-model.${extension}"`)
      .setHeader("Content-Length", file.length)
      .send(file);
  } catch (error) {
    sendError(req, res, error);
  }
});

export default router;
