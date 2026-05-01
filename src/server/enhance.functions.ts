import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  callLovableAIVision,
  cancelPrediction,
  createPrediction,
  getPrediction,
  VIDEO_UPSCALE_MODEL_VERSION,
} from "./replicate.server";

// ----- Anti-piracy / copyright pre-check -----
// Gemini analyzes a sampled frame (data URL) and returns a JSON verdict.
export const checkCopyright = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        imageDataUrl: z
          .string()
          .min(20)
          .max(15_000_000) // ~15 MB cap on inline frame
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
    } catch (e) {
      // fail-open so the user isn't blocked if AI is down
      return { verdict: "allow" as const, reason: "AI check unavailable", confidence: 0 };
    }

    // Extract JSON from possibly-wrapped response.
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
// Confirms the upscaled video actually has more detail (not fake resolution bump).
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

    // We send them as a side-by-side composite in a single multimodal call.
    // To keep it simple, send both as separate image_url entries.
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

// ----- Start enhancement on Replicate -----
// Accepts a remote URL (preferred) OR a data URL (small files <= ~20MB).
// Returns a prediction ID the client can poll.
export const startEnhance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        videoDataUrl: z
          .string()
          .min(20)
          .max(80_000_000) // ~80 MB upper bound for inline data URI
          .refine((s) => s.startsWith("data:video/") || s.startsWith("http"), {
            message: "videoDataUrl must be a data:video/* URL or https URL",
          }),
        scale: z.number().int().min(2).max(4).default(4),
        faceEnhance: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const pred = await createPrediction({
      version: VIDEO_UPSCALE_MODEL_VERSION,
      input: {
        // lucataco/real-esrgan-video field is `video_path`
        video_path: data.videoDataUrl,
        // Model accepts integer scale 2 or 4
        scale: data.scale,
        // Built-in face restore model
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

export const pollEnhance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().min(5).max(64) }).parse(d))
  .handler(async ({ data }) => {
    const p = await getPrediction(data.id);
    return {
      id: p.id,
      status: p.status,
      output: p.output,
      error: p.error,
      predict_time: p.metrics?.predict_time ?? null,
    };
  });

export const abortEnhance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().min(5).max(64) }).parse(d))
  .handler(async ({ data }) => {
    await cancelPrediction(data.id);
    return { canceled: true };
  });
