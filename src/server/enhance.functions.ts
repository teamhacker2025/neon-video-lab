import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  callLovableAIVision,
  cancelPrediction,
  createPrediction,
  deleteReplicateFile,
  getPrediction,
  parseProgressFromLogs,
  RIFE_MODEL,
  uploadReplicateFile,
  VIDEO_UPSCALE_MODEL_VERSION,
} from "./replicate.server";

// ----- Anti-piracy / copyright pre-check -----
export const checkCopyright = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        imageDataUrl: z
          .string()
          .min(20)
          .max(15_000_000)
          .startsWith("data:image/"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const prompt = `You are a copyright/piracy moderator for a video enhancement service.
Look at this video frame and decide if it likely contains pirated or copyrighted material the uploader probably does not own (TV shows, movies, sports broadcasts with broadcaster watermarks, paid streaming-service overlays like Netflix/Prime/Disney/Hotstar logos, theater-cam recordings).

Reply STRICTLY in compact JSON, no prose, no markdown:
{"verdict":"allow"|"warn"|"block","reason":"<<=120 chars>","confidence":0.0-1.0}

Use "block" only if you see strong piracy markers (streaming logos, theater-cam framing). Use "warn" if uncertain. Use "allow" for personal/UGC/stock-looking footage.`;

    let raw = "";
    try {
      raw = await callLovableAIVision({ prompt, imageDataUrl: data.imageDataUrl });
    } catch {
      return { verdict: "allow" as const, reason: "AI check unavailable", confidence: 0 };
    }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { verdict: "allow" as const, reason: "no parse", confidence: 0 };
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        verdict: "allow" | "warn" | "block";
        reason?: string;
        confidence?: number;
      };
      return {
        verdict: parsed.verdict ?? "allow",
        reason: (parsed.reason ?? "").slice(0, 200),
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      };
    } catch {
      return { verdict: "allow" as const, reason: "json error", confidence: 0 };
    }
  });

// ----- AI watchdog: compare before vs after frame -----
export const verifyEnhancement = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        beforeDataUrl: z.string().startsWith("data:image/").max(15_000_000),
        afterDataUrl: z.string().startsWith("data:image/").max(15_000_000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const prompt = `You are a quality auditor. Two frames from the SAME video moment: BEFORE enhancement and AFTER enhancement. Decide if the AFTER frame shows REAL added detail/sharpness/denoise — not just a stretched (fake) upscale.

Reply STRICTLY in compact JSON only:
{"real_enhancement":true|false,"sharpness_gain":0-100,"detail_gain":0-100,"noise_reduction":0-100,"verdict":"<<=140 chars>"}`;

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
              { type: "text", text: prompt },
              { type: "text", text: "BEFORE:" },
              { type: "image_url", image_url: { url: data.beforeDataUrl } },
              { type: "text", text: "AFTER:" },
              { type: "image_url", image_url: { url: data.afterDataUrl } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      return {
        real_enhancement: true,
        sharpness_gain: 0,
        detail_gain: 0,
        noise_reduction: 0,
        verdict: "AI auditor unavailable",
      };
    }
    const json = await res.json();
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) {
      return {
        real_enhancement: true,
        sharpness_gain: 0,
        detail_gain: 0,
        noise_reduction: 0,
        verdict: "Could not parse AI response",
      };
    }
    try {
      const parsed = JSON.parse(m[0]);
      return {
        real_enhancement: !!parsed.real_enhancement,
        sharpness_gain: Number(parsed.sharpness_gain) || 0,
        detail_gain: Number(parsed.detail_gain) || 0,
        noise_reduction: Number(parsed.noise_reduction) || 0,
        verdict: String(parsed.verdict ?? "").slice(0, 200),
      };
    } catch {
      return {
        real_enhancement: true,
        sharpness_gain: 0,
        detail_gain: 0,
        noise_reduction: 0,
        verdict: "Parse error",
      };
    }
  });

// ----- Chunked upload to Replicate Files API (large videos) -----
// Client sends base64 chunks; server reassembles in-memory and uploads once
// the final chunk arrives. Each chunk capped to ~6MB base64 (~4.5MB binary).
const uploadSessions = new Map<
  string,
  { chunks: Uint8Array[]; total: number; received: number; mime: string; name: string; createdAt: number }
>();

// Periodically prune stale sessions (>30 min) — server-side cleanup of temp uploads.
function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of uploadSessions) {
    if (now - v.createdAt > 30 * 60 * 1000) uploadSessions.delete(k);
  }
}

export const initUpload = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        filename: z.string().min(1).max(255),
        contentType: z.string().min(3).max(100).startsWith("video/"),
        totalBytes: z.number().int().min(1).max(500 * 1024 * 1024), // 500MB hard cap
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    pruneSessions();
    const sessionId = crypto.randomUUID();
    uploadSessions.set(sessionId, {
      chunks: [],
      total: data.totalBytes,
      received: 0,
      mime: data.contentType,
      name: data.filename,
      createdAt: Date.now(),
    });
    return { sessionId };
  });

export const uploadChunk = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        sessionId: z.string().uuid(),
        index: z.number().int().min(0).max(10_000),
        chunkBase64: z.string().min(1).max(8_000_000), // ~6MB binary per chunk
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sess = uploadSessions.get(data.sessionId);
    if (!sess) throw new Error("Upload session expired or invalid.");
    // Decode base64 → Uint8Array
    const binStr = atob(data.chunkBase64);
    const bin = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bin[i] = binStr.charCodeAt(i);
    sess.chunks[data.index] = bin;
    sess.received += bin.length;
    return { received: sess.received, total: sess.total };
  });

export const finalizeUpload = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ sessionId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sess = uploadSessions.get(data.sessionId);
    if (!sess) throw new Error("Upload session expired or invalid.");
    // Reassemble
    const totalLen = sess.chunks.reduce((acc, c) => acc + (c?.length ?? 0), 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of sess.chunks) {
      if (!c) throw new Error("Missing chunk — re-upload required.");
      merged.set(c, off);
      off += c.length;
    }
    const blob = new Blob([merged], { type: sess.mime });
    const file = await uploadReplicateFile({
      blob,
      filename: sess.name,
      contentType: sess.mime,
    });
    // Free server memory immediately (temp cleanup)
    uploadSessions.delete(data.sessionId);
    return { fileId: file.id, url: file.urls.get, expiresAt: file.expires_at ?? null };
  });

// ----- Start enhancement on Replicate (Real-ESRGAN) -----
// Accepts EITHER a Replicate file URL (preferred, large videos) OR a data URL.
export const startEnhance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        videoUrl: z
          .string()
          .min(20)
          .max(80_000_000)
          .refine(
            (s) => s.startsWith("data:video/") || s.startsWith("http"),
            { message: "videoUrl must be data:video/* or https URL" },
          ),
        scale: z.number().int().min(2).max(4).default(4),
        faceEnhance: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const pred = await createPrediction({
      version: VIDEO_UPSCALE_MODEL_VERSION,
      input: {
        video_path: data.videoUrl,
        scale: data.scale,
        model_name: data.faceEnhance ? "RealESRGAN_x4plus" : "realesr-animevideov3",
      },
    });
    return {
      id: pred.id,
      status: pred.status,
      output: pred.output,
      error: pred.error,
    };
  });

// ----- Optional RIFE FPS interpolation step -----
// Boosts FPS (e.g. 24 → 60/100) for ultra-smooth playback. Runs AFTER upscale.
export const startInterpolate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        videoUrl: z.string().url(),
        targetFps: z.number().int().min(30).max(120).default(60),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const pred = await createPrediction({
      model: RIFE_MODEL,
      input: {
        video: data.videoUrl,
        fps: data.targetFps,
        model_version: "4.6",
      },
    });
    return {
      id: pred.id,
      status: pred.status,
      output: pred.output,
      error: pred.error,
    };
  });

// ----- Poll: now returns logs + parsed progress for real-time progress bar -----
export const pollEnhance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().min(5).max(64) }).parse(d))
  .handler(async ({ data }) => {
    const p = await getPrediction(data.id);
    const logs = p.logs ?? "";
    // Keep only last ~2KB of logs for the wire
    const logsTail = logs.length > 2000 ? logs.slice(-2000) : logs;
    return {
      id: p.id,
      status: p.status,
      output: p.output,
      error: p.error,
      predict_time: p.metrics?.predict_time ?? null,
      logs: logsTail,
      progress: parseProgressFromLogs(logs),
    };
  });

export const abortEnhance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().min(5).max(64) }).parse(d))
  .handler(async ({ data }) => {
    await cancelPrediction(data.id);
    return { canceled: true };
  });

// ----- Cleanup: delete uploaded source file from Replicate Files (TTL belt-and-braces) -----
export const cleanupFile = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ fileId: z.string().min(3).max(64) }).parse(d))
  .handler(async ({ data }) => {
    await deleteReplicateFile(data.fileId);
    return { deleted: true };
  });
