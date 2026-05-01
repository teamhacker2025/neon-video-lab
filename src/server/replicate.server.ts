// Server-only Replicate API helpers.
// Real-ESRGAN video upscaler + RIFE FPS interpolation models.
// Reads REPLICATE_API_TOKEN at call time (not module top-level) — env injection
// happens at handler invocation in TanStack Start server functions.

const REPLICATE_API = "https://api.replicate.com/v1";

// Public, well-known Replicate model versions (pinned).
// Real-ESRGAN video upscaler (4x) — accepts input video, returns enhanced video URL.
export const VIDEO_UPSCALE_MODEL_VERSION =
  "f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa"; // nightmareai/real-esrgan
// RIFE frame interpolation — converts low-FPS video to smooth high-FPS.
export const FPS_INTERPOLATE_MODEL_VERSION =
  "1f3a4ce134b51f4eb6b8c7f3a8e4a7bf2e1cf83ed9c0e9f7c8d4e9b1a4f4c5d6"; // pollinations/rife placeholder

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

export async function createPrediction(args: {
  version: string;
  input: Record<string, unknown>;
}): Promise<ReplicatePrediction> {
  const token = getToken();
  const res = await fetch(`${REPLICATE_API}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait=5", // try to return quickly if model is fast
    },
    body: JSON.stringify({ version: args.version, input: args.input }),
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

// Lovable AI Gateway — used for real-content verification + anti-piracy filter.
export async function callLovableAIVision(args: {
  prompt: string;
  imageDataUrl: string;
  jsonSchema?: Record<string, unknown>;
}): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured");

  const body: Record<string, unknown> = {
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
  };

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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
