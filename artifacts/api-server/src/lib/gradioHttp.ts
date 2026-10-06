// Talks to a Gradio app (e.g. a Hugging Face Space) with plain HTTP so every step is visible and has a timeout.
// Works with Gradio 4/5/6 style apps: reads /config for the API prefix, uploads the image, then uses /call/<api>.

export interface GradioFileData {
  path?: string;
  url?: string;
  orig_name?: string;
}

export interface HttpRunOptions {
  space: string; // "owner/name" or a full https:// URL
  image: Buffer;
  contentType: string;
  removeBg: boolean;
  foregroundRatio: number;
  resolution: number;
  token?: string;
  preprocessTimeoutMs: number;
  generateTimeoutMs: number;
  onStatus: (progress: number, message: string) => void;
  log: (message: string) => void;
}

export interface GradioConfig {
  api_prefix?: string;
  version?: string;
  protocol?: string;
  dependencies?: { id: number; api_name?: string | false | null; targets?: unknown[][] }[];
}

let dbg: (message: string) => void = () => {};

const BAD_STAGES = new Set(["RUNTIME_ERROR", "BUILD_ERROR", "CONFIG_ERROR", "PAUSED", "NO_APP_FILE", "DELETING"]);

function headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}`, ...extra } : extra;
}

async function resolveRoot(space: string, token: string | undefined, log: (m: string) => void): Promise<string> {
  if (/^https?:\/\//i.test(space)) return space.replace(/\/+$/, "");
  const res = await fetch(`https://huggingface.co/api/spaces/${space}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Space ${space} was not found or is private (HTTP ${res.status}).`);
  const info = (await res.json()) as { host?: string; runtime?: { stage?: string } };
  const stage = info.runtime?.stage;
  log(`space status: ${stage ?? "unknown"}`);
  if (stage && BAD_STAGES.has(stage)) throw new Error(`Space ${space} is not usable (status ${stage}).`);
  if (!info.host) throw new Error(`Space ${space} has no public address.`);
  return info.host.replace(/\/+$/, "");
}

async function getConfig(root: string, token: string | undefined, log: (m: string) => void): Promise<GradioConfig> {
  let lastError = "no response";
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      const res = await fetch(`${root}/config`, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
      if (res.ok) return (await res.json()) as GradioConfig;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    log(`waiting for the Space to wake up (${lastError}), attempt ${attempt}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`The Space never became ready (${lastError}).`);
}

async function paramCount(root: string, prefix: string, api: string, token?: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${root}${prefix}/info`, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { named_endpoints?: Record<string, { parameters?: unknown[] }> };
    return info.named_endpoints?.[`/${api}`]?.parameters?.length;
  } catch {
    return undefined;
  }
}

async function uploadImage(root: string, prefix: string, image: Buffer, contentType: string, token?: string): Promise<string> {
  const ext = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  const form = new FormData();
  form.append("files", new Blob([Uint8Array.from(image)], { type: contentType }), `input.${ext}`);
  const res = await fetch(`${root}${prefix}/upload`, {
    method: "POST",
    body: form,
    headers: headers(token),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Image upload failed (HTTP ${res.status}).`);
  const paths = (await res.json()) as string[];
  if (!Array.isArray(paths) || typeof paths[0] !== "string") throw new Error("The Space did not accept the image upload.");
  return paths[0];
}

async function callApi(
  root: string,
  prefix: string,
  config: GradioConfig,
  api: string,
  data: unknown[],
  timeoutMs: number,
  token: string | undefined,
  onWait: (seconds: number) => void,
): Promise<unknown[]> {
  const post = await fetch(`${root}${prefix}/call/${api}`, {
    method: "POST",
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(60_000),
  });
  if (post.status === 404) {
    // Older Gradio versions have no /call route: use the classic queue protocol instead.
    return callQueue(root, prefix, config, api, data, timeoutMs, token, onWait);
  }
  if (!post.ok) throw new Error(`Calling /${api} failed (HTTP ${post.status}): ${(await post.text()).slice(0, 300)}`);
  const { event_id: eventId } = (await post.json()) as { event_id?: string };
  if (!eventId) throw new Error(`The Space did not accept the /${api} request.`);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const ticker = setInterval(() => onWait(Math.round((Date.now() - started) / 1000)), 10_000);
  try {
    const res = await fetch(`${root}${prefix}/call/${api}/${eventId}`, { headers: headers(token), signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Reading the /${api} result failed (HTTP ${res.status}).`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (event === "complete") return JSON.parse(payload) as unknown[];
          if (event === "error") throw new Error(`The Space reported an error in /${api}${payload && payload !== "null" ? `: ${payload}` : " (see the Space logs)"}.`);
        }
      }
    }
    throw new Error(`The /${api} result stream ended without a result.`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`/${api} timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
  }
}


async function callQueue(
  root: string,
  prefix: string,
  config: GradioConfig,
  api: string,
  data: unknown[],
  timeoutMs: number,
  token: string | undefined,
  onWait: (seconds: number) => void,
): Promise<unknown[]> {
  const deps = config.dependencies ?? [];
  const depIndex = deps.findIndex((d) => d.api_name === api);
  const dep = depIndex >= 0 ? deps[depIndex] : undefined;
  if (!dep) {
    const names = deps.map((d) => d.api_name).filter((n): n is string => typeof n === "string");
    throw new Error(`The Space has no /${api} endpoint. Available endpoints: ${names.join(", ") || "none"}`);
  }
  // Older Gradio versions have no "id" on dependencies: the position in the list is the fn_index.
  const fnIndex = typeof dep.id === "number" ? dep.id : depIndex;
  const session = Math.random().toString(36).slice(2, 12);
  const triggerId = Array.isArray(dep.targets?.[0]) ? dep.targets?.[0]?.[0] ?? null : null;
  const join = await fetch(`${root}${prefix}/queue/join`, {
    method: "POST",
    headers: headers(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ data, event_data: null, fn_index: fnIndex, trigger_id: triggerId, session_hash: session }),
    signal: AbortSignal.timeout(60_000),
  });
  let joinInfo: { event_id?: string } = {};
  let streamUrl = `${root}${prefix}/queue/data?session_hash=${session}`;
  if (join.status === 405) {
    // Oldest queue protocol: joining is a GET request that itself streams the progress messages.
    dbg(`this Space uses the oldest queue protocol for /${api}`);
    streamUrl = `${root}${prefix}/queue/join?fn_index=${fnIndex}&session_hash=${session}`;
  } else {
    if (!join.ok) throw new Error(`Joining the Space queue for /${api} failed (HTTP ${join.status}): ${(await join.text()).slice(0, 300)}`);
    joinInfo = (await join.json().catch(() => ({}))) as { event_id?: string };
    dbg(`joined queue for /${api} (event ${joinInfo.event_id ?? "?"})`);
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const ticker = setInterval(() => onWait(Math.round((Date.now() - started) / 1000)), 10_000);
  try {
    const res = await fetch(streamUrl, { headers: headers(token), signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Reading the /${api} queue failed (HTTP ${res.status}).`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastMsg = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        let msg: { msg?: string; event_id?: string; success?: boolean; output?: { data?: unknown[]; error?: string | null } };
        try {
          msg = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (msg.msg && msg.msg !== lastMsg) {
          lastMsg = msg.msg;
          dbg(`/${api} queue message: ${msg.msg}`);
        }
        if (msg.msg === "send_data") {
          // Older Gradio protocol: the data is sent after the server asks for it.
          const sent = await fetch(`${root}${prefix}/queue/data`, {
            method: "POST",
            headers: headers(token, { "Content-Type": "application/json" }),
            body: JSON.stringify({ data, event_data: null, event_id: msg.event_id ?? joinInfo.event_id, fn_index: fnIndex, trigger_id: triggerId, session_hash: session }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!sent.ok) throw new Error(`Sending data for /${api} failed (HTTP ${sent.status}).`);
        }
        if (msg.msg === "queue_full") throw new Error("The free server queue is full right now. Try again in a few minutes.");
        if (msg.msg === "process_completed") {
          if (msg.success === false || msg.output?.error) throw new Error(`The Space reported an error in /${api}: ${msg.output?.error ?? "unknown error"}`);
          if (!Array.isArray(msg.output?.data)) throw new Error(`The Space returned no data for /${api}.`);
          return msg.output.data;
        }
      }
    }
    throw new Error(`The /${api} queue stream ended without a result.`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`/${api} timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
  }
}

function asFileData(value: unknown): GradioFileData | undefined {
  return typeof value === "object" && value !== null && ("path" in value || "url" in value) ? (value as GradioFileData) : undefined;
}

async function generateInner(o: HttpRunOptions): Promise<{ data: Buffer; fileName: string }> {
  const t0 = Date.now();
  const log = (m: string) => o.log(`+${Math.round((Date.now() - t0) / 1000)}s ${m}`);
  dbg = log;

  o.onStatus(8, "Contacting the free 3D server");
  const root = await resolveRoot(o.space, o.token, log);
  log(`address ${root}`);
  const config = await getConfig(root, o.token, log);
  const prefix = config.api_prefix ?? "";
  log(`connected (gradio ${config.version ?? "?"}, protocol ${config.protocol ?? "?"}, api prefix "${prefix}")`);
  log(`endpoints: ${(config.dependencies ?? []).map((d) => d.api_name).filter((n) => typeof n === "string").join(", ") || "none listed"}`);

  o.onStatus(15, "Uploading your image");
  const uploaded = await uploadImage(root, prefix, o.image, o.contentType, o.token);
  log("image uploaded");

  const n = await paramCount(root, prefix, "preprocess", o.token);
  const preArgs: unknown[] = [{ path: uploaded, orig_name: "input.png", meta: { _type: "gradio.FileData" } }, o.removeBg, o.foregroundRatio];
  const preData = n === undefined ? preArgs : preArgs.slice(0, Math.max(1, n));
  o.onStatus(25, "Preparing the image (removing background)");
  const pre = await callApi(root, prefix, config, "preprocess", preData, o.preprocessTimeoutMs, o.token, (s) => {
    log(`still preprocessing... ${s}s`);
    o.onStatus(25, `Preparing the image on the free server (${s}s)`);
  });
  const processed = asFileData(pre[0]);
  if (!processed?.path) throw new Error("The Space returned no processed image.");
  log("preprocess done");

  const g = await paramCount(root, prefix, "generate", o.token);
  const genImage = { path: processed.path, orig_name: processed.orig_name ?? "processed.png", meta: { _type: "gradio.FileData" } };
  const genData: unknown[] = g !== undefined && g >= 2 ? [genImage, o.resolution] : [genImage];
  o.onStatus(45, "Building the 3D mesh on the free server");
  const gen = await callApi(root, prefix, config, "generate", genData, o.generateTimeoutMs, o.token, (s) => {
    log(`still generating... ${s}s`);
    o.onStatus(Math.min(84, 45 + Math.floor(s / 8)), `Building the 3D mesh on the free server (${s}s - the free server can be slow)`);
  });
  const files = gen.map(asFileData).filter((f): f is GradioFileData => !!f);
  const nameOf = (f: GradioFileData) => f.orig_name ?? f.path ?? f.url ?? "";
  const chosen = files.find((f) => /\.glb$/i.test(nameOf(f))) ?? files[files.length - 1];
  if (!chosen) throw new Error("The Space returned no 3D file.");
  log("generate done, downloading");

  o.onStatus(88, "Downloading the finished model");
  const url = chosen.url ?? `${root}${prefix}/file=${chosen.path}`;
  const res = await fetch(url, { headers: headers(o.token), signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Could not download the generated model (HTTP ${res.status}).`);
  const data = Buffer.from(await res.arrayBuffer());
  log(`downloaded ${data.length} bytes`);
  return { data, fileName: nameOf(chosen) };
}

export const GRADIO_HTTP_VERSION = "v9";

export async function generateViaHttp(o: HttpRunOptions): Promise<{ data: Buffer; fileName: string }> {
  try {
    return await generateInner(o);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${GRADIO_HTTP_VERSION}] ${message}`);
  }
}
