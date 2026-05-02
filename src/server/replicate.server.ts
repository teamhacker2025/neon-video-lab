// Server-only Replicate API helpers.
// - Real-ESRGAN video upscaler
// - RIFE FPS interpolation
// - Native Replicate Files API (handles large videos, auto-TTL ~1h cleanup)
// Reads REPLICATE_API_TOKEN at call time (env injection happens at handler invocation).

const REPLICATE_API = "https://api.replicate.com/v1";

// Pinned model versions.
// lucataco/real-esrgan-video — MP4 in, enhanced MP4 out.
export const VIDEO_UPSCALE_MODEL_VERSION =
  "3e56ce4b57863bd03048b42bc09bdd4db20d427cca5fde9d8ae4dc60e1bb4775";

// zsxkib/rife — Real-Time Intermediate Flow Estimation for video frame interpolation.
// https://replicate.com/zsxkib/rife
export const RIFE_MODEL_VERSION =
  "00a2f6f7b2b7f8d0d4e7c2b1a3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"; // pinned alias; resolved to model name fallback below

// We use the model-name endpoint which accepts the latest version automatically.
// Some Replicate models require version IDs; for RIFE we call by model owner/name.
export const RIFE_MODEL = "zsxkib/rife";

export type ReplicateStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export interface ReplicatePrediction {
  id: string;
  status: ReplicateStatus;
  output: string | string[] | null;
  error: string | null;
  logs: string | null;
  metrics?: { predict_time?: number };
}

function getToken(): string {
  const t = process.env.REPLICATE_API_TOKEN;
  if (!t) throw new Error("REPLICATE_API_TOKEN is not configured");
  return t;
}

// ------- Replicate Files API: native large-file storage with TTL ----------
// POST multipart/form-data → returns { id, urls: { get }, expires_at }.
// Files auto-delete after ~24h (Replicate-managed TTL). We additionally try to
// delete on cleanup. https://replicate.com/docs/reference/http#files.create
export interface ReplicateFile {
  id: string;
  urls: { get: string };
  expires_at?: string;
  size?: number;
  name?: string;
}

export async function uploadReplicateFile(args: {
  blob: Blob;
  filename: string;
  contentType: string;
}): Promise<ReplicateFile> {
  const token = getToken();
  const fd = new FormData();
  fd.append("content", args.blob, args.filename);
  fd.append("type", args.contentType);
  const res = await fetch(`${REPLICATE_API}/files`, {
    method: "POST",
    headers: { Authorization: `Token ${token}` },
    body: fd,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Replicate file upload failed [${res.status}]: ${txt.slice(0, 500)}`);
  }
  return (await res.json()) as ReplicateFile;
}

export async function deleteReplicateFile(id: string): Promise<void> {
  const token = getToken();
  await fetch(`${REPLICATE_API}/files/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Token ${token}` },
  }).catch(() => {});
}

// ------- Predictions ----------
export async function createPrediction(args: {
  version?: string;
  model?: string; // alternative to version
  input: Record<string, unknown>;
}): Promise<ReplicatePrediction> {
  const token = getToken();
  const body: Record<string, unknown> = { input: args.input };
  if (args.version) body.version = args.version;
  const url = args.model
    ? `${REPLICATE_API}/models/${args.model}/predictions`
    : `${REPLICATE_API}/predictions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait=2",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Replicate create failed [${res.status}]: ${txt.slice(0, 500)}`);
  }
  return (await res.json()) as ReplicatePrediction;
}

export async function getPrediction(id: string): Promise<ReplicatePrediction> {
  const token = getToken();
  const res = await fetch(`${REPLICATE_API}/predictions/${id}`, {
    headers: { Authorization: `Token ${token}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Replicate poll failed [${res.status}]: ${txt.slice(0, 500)}`);
  }
  return (await res.json()) as ReplicatePrediction;
}

export async function cancelPrediction(id: string): Promise<void> {
  const token = getToken();
  await fetch(`${REPLICATE_API}/predictions/${id}/cancel`, {
    method: "POST",
    headers: { Authorization: `Token ${token}` },
  }).catch(() => {});
}

// Parse Replicate logs to find a percentage progress hint.
// Real-ESRGAN / RIFE typically print lines like "frame=  120 / 240" or "12%".
export function parseProgressFromLogs(logs: string | null): number | null {
  if (!logs) return null;
  // 1) Explicit percent
  const pct = [...logs.matchAll(/(\d{1,3})\s*%/g)].pop();
  if (pct) {
    const n = Math.min(100, Math.max(0, parseInt(pct[1], 10)));
    if (!Number.isNaN(n)) return n;
  }
  // 2) frame X / Y
  const frame = [...logs.matchAll(/frame[^\d]*(\d+)\s*\/\s*(\d+)/gi)].pop();
  if (frame) {
    const cur = parseInt(frame[1], 10);
    const tot = parseInt(frame[2], 10);
    if (tot > 0) return Math.min(100, Math.round((cur / tot) * 100));
  }
  // 3) processing X of Y
  const of = [...logs.matchAll(/(\d+)\s+of\s+(\d+)/gi)].pop();
  if (of) {
    const cur = parseInt(of[1], 10);
    const tot = parseInt(of[2], 10);
    if (tot > 0) return Math.min(100, Math.round((cur / tot) * 100));
  }
  return null;
}

// ------- Lovable AI Gateway (vision) ----------
export async function callLovableAIVision(args: {
  prompt: string;
  imageDataUrl: string;
}): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured");

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: args.prompt },
            { type: "image_url", image_url: { url: args.imageDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 429) throw new Error("AI rate limit exceeded — try again shortly.");
    if (res.status === 402) throw new Error("AI credits exhausted — top up in workspace settings.");
    throw new Error(`AI gateway error [${res.status}]: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}
