import { createFileRoute, Link, useServerFn } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  abortEnhance,
  checkCopyright,
  pollEnhance,
  startEnhance,
  verifyEnhancement,
} from "@/server/enhance.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEONUPSCALE — Real AI Video Enhancer (Real-ESRGAN GPU)" },
      {
        name: "description",
        content:
          "Super-fast AI video enhancement powered by Real-ESRGAN on GPU. Up to 4× upscale, RIFE FPS interpolation, anti-piracy filter, and Gemini quality auditor — real enhancement, not fake resolution.",
      },
      { property: "og:title", content: "NEONUPSCALE — Real GPU AI Video Enhancer" },
      {
        property: "og:description",
        content: "Real-ESRGAN 4× upscale + RIFE FPS boost + AI quality watchdog. ~30-60s per minute of video.",
      },
    ],
  }),
  component: Index,
});

type Step =
  | "idle"
  | "scanning" // anti-piracy AI scan
  | "uploading" // sending to server
  | "queued" // Replicate queued
  | "enhancing" // GPU running
  | "auditing" // verify watchdog
  | "done"
  | "error";

const STEPS: { id: Exclude<Step, "idle" | "done" | "error">; label: string }[] = [
  { id: "scanning", label: "AI Safety Scan" },
  { id: "uploading", label: "Uploading" },
  { id: "queued", label: "Queued" },
  { id: "enhancing", label: "GPU Enhancing" },
  { id: "auditing", label: "AI Audit" },
];

const SCALE_OPTIONS = [
  { id: 2, label: "2× HD+", subtitle: "Fast (~20-40s)" },
  { id: 4, label: "4× Ultra", subtitle: "Best quality (~30-60s)" },
] as const;

const MAX_FILE_MB = 60; // safe inline upload size for Replicate data URI
const MAX_PROCESS_MS = 8 * 60 * 1000; // 8-min server-side cap
const POLL_MS = 1500;

function classNames(...s: (string | false | null | undefined)[]) {
  return s.filter(Boolean).join(" ");
}

function fmtBytes(n: number) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

function fmtTime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Read a File and return a "data:video/...;base64,..." URL via FileReader (no full base64 in JS land).
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

// Sample one frame from a video file at a given time and return a JPEG data URL.
async function sampleFrameAt(file: File, atSec: number, maxW = 640): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.crossOrigin = "anonymous";
    v.src = url;
    v.onloadedmetadata = () => {
      const t = Math.min(Math.max(0.1, atSec), Math.max(0.1, (v.duration || 1) - 0.1));
      v.currentTime = t;
    };
    v.onseeked = () => {
      try {
        const ratio = (v.videoHeight || 360) / (v.videoWidth || 640);
        const w = Math.min(maxW, v.videoWidth || maxW);
        const h = Math.round(w * ratio);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");
        ctx.drawImage(v, 0, 0, w, h);
        const data = c.toDataURL("image/jpeg", 0.82);
        URL.revokeObjectURL(url);
        resolve(data);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode video for frame sampling"));
    };
  });
}

// Sample one frame from a remote video URL.
async function sampleFrameFromUrl(url: string, atSec: number, maxW = 640): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.crossOrigin = "anonymous";
    v.src = url;
    v.onloadedmetadata = () => {
      const t = Math.min(Math.max(0.1, atSec), Math.max(0.1, (v.duration || 1) - 0.1));
      v.currentTime = t;
    };
    v.onseeked = () => {
      try {
        const ratio = (v.videoHeight || 360) / (v.videoWidth || 640);
        const w = Math.min(maxW, v.videoWidth || maxW);
        const h = Math.round(w * ratio);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");
        ctx.drawImage(v, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.82));
      } catch (e) {
        reject(e);
      }
    };
    v.onerror = () => reject(new Error("Could not decode remote video for audit"));
  });
}

function Index() {
  const startEnhanceFn = useServerFn(startEnhance);
  const pollEnhanceFn = useServerFn(pollEnhance);
  const abortEnhanceFn = useServerFn(abortEnhance);
  const checkCopyrightFn = useServerFn(checkCopyright);
  const verifyEnhancementFn = useServerFn(verifyEnhancement);

  const [file, setFile] = useState<File | null>(null);
  const [inputUrl, setInputUrl] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [statusLine, setStatusLine] = useState("");

  const [scale, setScale] = useState<2 | 4>(4);
  const [faceEnhance, setFaceEnhance] = useState(true);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const [audit, setAudit] = useState<null | {
    real_enhancement: boolean;
    sharpness_gain: number;
    detail_gain: number;
    noise_reduction: number;
    verdict: string;
  }>(null);
  const [piracyWarn, setPiracyWarn] = useState<string | null>(null);

  const [sliderPos, setSliderPos] = useState(50);
  const beforeRef = useRef<HTMLVideoElement | null>(null);
  const afterRef = useRef<HTMLVideoElement | null>(null);

  const startTsRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  const predIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      setError("Please select a valid video file.");
      return;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`File too large (${fmtBytes(f.size)}). Max ${MAX_FILE_MB} MB for direct AI processing.`);
      return;
    }
    setError(null);
    setOutputUrl(null);
    setProgress(0);
    setStep("idle");
    setAudit(null);
    setPiracyWarn(null);
    setFile(f);
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    setInputUrl(URL.createObjectURL(f));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onPickFile(f);
  };

  const cleanup = () => {
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const cancel = useCallback(async () => {
    cancelledRef.current = true;
    if (predIdRef.current) {
      try {
        await abortEnhanceFn({ data: { id: predIdRef.current } });
      } catch {
        /* noop */
      }
    }
    cleanup();
    setStep("idle");
    setProgress(0);
    setStatusLine("Cancelled");
  }, [abortEnhanceFn]);

  const enhance = async () => {
    if (!file) return;
    if (!acceptedTerms) {
      setError("Please accept the Terms & Copyright policy to continue.");
      return;
    }
    setError(null);
    setOutputUrl(null);
    setAudit(null);
    setPiracyWarn(null);
    setProgress(0);
    setElapsed(0);
    cancelledRef.current = false;
    predIdRef.current = null;

    startTsRef.current = performance.now();
    tickRef.current = window.setInterval(() => {
      const e = performance.now() - startTsRef.current;
      setElapsed(e);
      if (e > MAX_PROCESS_MS) {
        cancel();
        setStep("error");
        setError("Processing exceeded the 8-minute limit. Try a shorter clip or 2× scale.");
      }
    }, 250);

    try {
      // 1) Anti-piracy AI scan on first usable frame
      setStep("scanning");
      setStatusLine("Sampling frame for safety check…");
      setProgress(4);
      const beforeFrame = await sampleFrameAt(file, 1.0).catch(() => sampleFrameAt(file, 0.2));
      setProgress(8);
      const verdict = await checkCopyrightFn({ data: { imageDataUrl: beforeFrame } });
      if (cancelledRef.current) return;
      if (verdict.verdict === "block") {
        cleanup();
        setStep("error");
        setError(
          `Upload blocked by anti-piracy AI: ${verdict.reason || "looks like copyrighted material."} If this is a mistake and you own the rights, see our Copyright policy.`,
        );
        return;
      }
      if (verdict.verdict === "warn") {
        setPiracyWarn(verdict.reason || "AI flagged this as possibly copyrighted — proceeding under your declared ownership.");
      }
      setProgress(14);

      // 2) Encode to data URL & send to server
      setStep("uploading");
      setStatusLine("Encoding & uploading to GPU…");
      const dataUrl = await fileToDataURL(file);
      if (cancelledRef.current) return;
      setProgress(22);

      const created = await startEnhanceFn({
        data: { videoDataUrl: dataUrl, scale, faceEnhance },
      });
      if (cancelledRef.current) return;
      predIdRef.current = created.id;
      setStatusLine(`Prediction ${created.id.slice(0, 8)} queued`);
      setProgress(28);

      // 3) Poll
      setStep("queued");
      let lastStatus = created.status;
      let pollProgress = 30;
      while (true) {
        if (cancelledRef.current) return;
        const p = await pollEnhanceFn({ data: { id: created.id } });
        lastStatus = p.status;
        setStatusLine(`GPU ${p.status}…`);

        if (p.status === "processing") setStep("enhancing");

        // Smooth fake-progress bar (real % isn't reported by Replicate for video)
        pollProgress = Math.min(85, pollProgress + 1.2);
        setProgress(pollProgress);

        if (p.status === "succeeded") {
          const out = Array.isArray(p.output) ? p.output[0] : p.output;
          if (!out || typeof out !== "string") throw new Error("Replicate returned no output URL.");
          setProgress(88);

          // 4) AI quality audit — sample frame from output and compare
          setStep("auditing");
          setStatusLine("AI auditing real enhancement…");
          try {
            const afterFrame = await sampleFrameFromUrl(out, 1.0);
            const a = await verifyEnhancementFn({
              data: { beforeDataUrl: beforeFrame, afterDataUrl: afterFrame },
            });
            setAudit(a);
          } catch {
            // non-fatal
          }

          setOutputUrl(out);
          setProgress(100);
          setStep("done");
          cleanup();
          return;
        }
        if (p.status === "failed" || p.status === "canceled") {
          throw new Error(p.error || `Replicate ${p.status}`);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      if (cancelledRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || "Processing failed.");
      setStep("error");
      cleanup();
    }
  };

  const reset = () => {
    cleanup();
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    setFile(null);
    setInputUrl(null);
    setOutputUrl(null);
    setStep("idle");
    setProgress(0);
    setError(null);
    setElapsed(0);
    setStatusLine("");
    setAudit(null);
    setPiracyWarn(null);
  };

  // Sync before/after playback for slider compare
  useEffect(() => {
    const a = beforeRef.current;
    const b = afterRef.current;
    if (!a || !b) return;
    const sync = () => {
      if (Math.abs(a.currentTime - b.currentTime) > 0.1) b.currentTime = a.currentTime;
    };
    const play = () => b.play().catch(() => {});
    const pause = () => b.pause();
    a.addEventListener("timeupdate", sync);
    a.addEventListener("play", play);
    a.addEventListener("pause", pause);
    a.addEventListener("seeked", sync);
    return () => {
      a.removeEventListener("timeupdate", sync);
      a.removeEventListener("play", play);
      a.removeEventListener("pause", pause);
      a.removeEventListener("seeked", sync);
    };
  }, [outputUrl]);

  const stepIndex = useMemo(() => {
    if (step === "idle") return -1;
    if (step === "done") return STEPS.length;
    if (step === "error") return -2;
    return STEPS.findIndex((s) => s.id === step);
  }, [step]);

  const isProcessing = step !== "idle" && step !== "done" && step !== "error";

  return (
    <div className="relative min-h-screen text-foreground">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-30" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#ff0050]/60 to-transparent" />

      {/* Nav */}
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-md glass-strong">
            <span className="font-display text-base neon-text">N</span>
          </div>
          <div className="leading-tight">
            <div className="font-display text-lg tracking-widest">
              NEON<span className="neon-text">UPSCALE</span>
            </div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">Real AI Video Enhancer</div>
          </div>
        </div>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a href="#features" className="hover:text-foreground">Features</a>
          <a href="#how" className="hover:text-foreground">How it works</a>
          <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
          <Link to="/terms" className="hover:text-foreground">Terms</Link>
        </nav>
        <div className="hidden md:block">
          <span className="rounded-full px-3 py-1 text-[11px] uppercase tracking-widest bg-[#ff0050]/15 text-[#ff7aa3] neon-border">
            Real-ESRGAN GPU
          </span>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 pt-6 pb-10">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-[#ff0050]/30 bg-[#ff0050]/10 px-3 py-1 text-xs uppercase tracking-[0.25em] text-[#ff7aa3]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff0050] pulse-neon" />
            Real GPU AI · Not Fake Upscale
          </div>
          <h1 className="font-display text-4xl leading-tight md:text-6xl">
            Enhance Videos with <span className="neon-text">Real AI</span> in Seconds
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-sm text-muted-foreground md:text-base">
            Real-ESRGAN GPU upscaling · Optional face restore · Anti-piracy filter · Gemini quality auditor that verifies actual detail gain — not just stretched pixels.
          </p>
        </div>
      </section>

      {/* Main card */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-20">
        <div className="glass-strong relative overflow-hidden rounded-2xl p-6 md:p-8 scanline">
          {/* Step tracker */}
          <ol className="relative mb-8 grid grid-cols-5 gap-2 md:gap-4">
            {STEPS.map((s, i) => {
              const active = i === stepIndex;
              const done = i < stepIndex || step === "done";
              return (
                <li key={s.id} className="flex flex-col items-center gap-2">
                  <div
                    className={classNames(
                      "flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold transition-all",
                      done && "border-[#ff0050] bg-[#ff0050] text-white",
                      active && "border-[#ff0050] text-[#ff0050] pulse-neon",
                      !done && !active && "border-white/15 text-muted-foreground",
                    )}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <span
                    className={classNames(
                      "text-center text-[10px] uppercase tracking-[0.18em] md:text-xs",
                      (active || done) ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {s.label}
                  </span>
                </li>
              );
            })}
            <div className="pointer-events-none absolute left-[10%] right-[10%] top-[18px] -z-0 h-px bg-white/10">
              <div
                className="h-full bg-gradient-to-r from-[#ff0050] to-[#ff5c8a] transition-all duration-500"
                style={{
                  width: `${Math.max(0, Math.min(100, ((stepIndex < 0 ? 0 : stepIndex) / (STEPS.length - 1)) * 100))}%`,
                }}
              />
            </div>
          </ol>

          <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
            {/* Left: dropzone / preview */}
            <div>
              {!file && (
                <label
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDrop}
                  className="group relative flex h-[360px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-8 text-center transition hover:border-[#ff0050]/60 hover:bg-[#ff0050]/[0.04]"
                >
                  <input
                    type="file"
                    accept="video/*"
                    className="sr-only"
                    onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                  />
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#ff0050]/10 neon-border">
                    <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-[#ff0050]" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
                    </svg>
                  </div>
                  <div className="font-display text-lg">Drop your video here</div>
                  <div className="mt-1 text-sm text-muted-foreground">or click to browse · MP4, MOV, WebM</div>
                  <div className="mt-6 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    Max {MAX_FILE_MB} MB · Recommended ≤ 60 sec
                  </div>
                </label>
              )}

              {file && !outputUrl && (
                <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
                  {inputUrl && <video src={inputUrl} controls className="aspect-video w-full bg-black" />}
                  <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="text-sm">
                      <div className="font-medium text-foreground">{file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {fmtBytes(file.size)} · {file.type || "video"}
                      </div>
                    </div>
                    <button
                      onClick={reset}
                      className="rounded-md border border-white/15 px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground hover:border-white/30"
                    >
                      Change
                    </button>
                  </div>
                </div>
              )}

              {outputUrl && inputUrl && (
                <div className="space-y-3">
                  <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black select-none">
                    <video ref={beforeRef} src={inputUrl} className="block aspect-video w-full bg-black" controls />
                    <div
                      className="pointer-events-none absolute inset-0 overflow-hidden"
                      style={{ clipPath: `inset(0 0 0 ${sliderPos}%)` }}
                    >
                      <video ref={afterRef} src={outputUrl} className="block aspect-video w-full bg-black" muted />
                    </div>
                    <div
                      className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-[#ff0050] shadow-[0_0_18px_rgba(255,0,80,0.7)]"
                      style={{ left: `${sliderPos}%` }}
                    >
                      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ff0050] px-2 py-1 text-[10px] font-bold tracking-widest text-white">
                        ⇆
                      </div>
                    </div>
                    <div className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-[10px] uppercase tracking-widest">Before</div>
                    <div className="absolute right-3 top-3 rounded bg-[#ff0050]/80 px-2 py-1 text-[10px] uppercase tracking-widest text-white">After</div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={sliderPos}
                    onChange={(e) => setSliderPos(parseInt(e.target.value))}
                    className="w-full accent-[#ff0050]"
                  />
                  <div className="flex flex-wrap gap-3">
                    <a
                      href={outputUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={`enhanced_${file?.name?.replace(/\.[^.]+$/, "") || "video"}.mp4`}
                      className="btn-neon rounded-md px-5 py-2.5 text-sm font-semibold uppercase tracking-widest"
                    >
                      Download Enhanced
                    </a>
                    <button
                      onClick={reset}
                      className="rounded-md border border-white/15 px-5 py-2.5 text-sm uppercase tracking-widest hover:border-white/30"
                    >
                      Enhance another
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Right: settings + status */}
            <div className="space-y-5">
              <div className="glass rounded-xl p-5">
                <div className="mb-3 text-[11px] uppercase tracking-[0.25em] text-muted-foreground">Upscale Factor</div>
                <div className="grid grid-cols-2 gap-2">
                  {SCALE_OPTIONS.map((r) => (
                    <button
                      key={r.id}
                      disabled={isProcessing}
                      onClick={() => setScale(r.id)}
                      className={classNames(
                        "rounded-md border px-2 py-3 text-xs font-medium transition",
                        scale === r.id
                          ? "border-[#ff0050] bg-[#ff0050]/15 text-foreground neon-border"
                          : "border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25",
                      )}
                    >
                      <div className="font-display text-base">{r.label}</div>
                      <div className="mt-0.5 text-[10px] tracking-wider">{r.subtitle}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Real-ESRGAN runs on a managed GPU. 4× restores the most detail; 2× is faster.
                </div>
              </div>

              <div className="glass rounded-xl p-5 space-y-3">
                <div className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">Advanced</div>
                <Toggle label="Face restoration (GFPGAN)" checked={faceEnhance} onChange={setFaceEnhance} disabled={isProcessing} />
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    disabled={isProcessing}
                    className="mt-1 h-4 w-4 accent-[#ff0050]"
                  />
                  <span className="text-muted-foreground">
                    I own the rights or have permission to enhance this video, and I accept the{" "}
                    <Link to="/terms" className="text-[#ff7aa3] underline">Terms</Link> and{" "}
                    <Link to="/copyright" className="text-[#ff7aa3] underline">Copyright</Link> policy.
                  </span>
                </label>
              </div>

              <div className="glass rounded-xl p-5">
                <button
                  disabled={!file || isProcessing || !acceptedTerms}
                  onClick={enhance}
                  className="btn-neon w-full rounded-md px-5 py-3 text-sm font-bold uppercase tracking-[0.2em]"
                >
                  {isProcessing ? "Processing…" : "Enhance with AI"}
                </button>
                {isProcessing && (
                  <button
                    onClick={cancel}
                    className="mt-2 w-full rounded-md border border-white/15 px-5 py-2 text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground hover:border-white/30"
                  >
                    Cancel
                  </button>
                )}

                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-widest text-muted-foreground">
                    <span>
                      {step === "idle"
                        ? "Ready"
                        : step === "done"
                        ? "Complete"
                        : step === "error"
                        ? "Error"
                        : STEPS.find((s) => s.id === step)?.label}
                    </span>
                    <span className="tabular-nums text-foreground">{Math.floor(progress)}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                    <div
                      className={classNames(
                        "h-full rounded-full transition-[width] duration-300",
                        step === "error" ? "bg-red-500" : "bg-gradient-to-r from-[#ff0050] to-[#ff5c8a]",
                      )}
                      style={{ width: `${progress}%`, boxShadow: "0 0 14px rgba(255,0,80,0.6)" }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
                    <span>Elapsed {fmtTime(elapsed)} / 8:00 limit</span>
                    {statusLine && (
                      <span className="truncate max-w-[60%] font-mono normal-case tracking-normal text-[10px] opacity-70">{statusLine}</span>
                    )}
                  </div>
                </div>

                {piracyWarn && (
                  <div className="mt-4 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
                    <strong>AI notice:</strong> {piracyWarn}
                  </div>
                )}

                {audit && (
                  <div className="mt-4 rounded-md border border-[#ff0050]/30 bg-[#ff0050]/5 p-3 text-xs">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-display text-foreground">AI Quality Audit</span>
                      <span
                        className={classNames(
                          "rounded px-2 py-0.5 text-[10px] uppercase tracking-widest",
                          audit.real_enhancement ? "bg-emerald-500/20 text-emerald-300" : "bg-yellow-500/20 text-yellow-300",
                        )}
                      >
                        {audit.real_enhancement ? "Real" : "Marginal"}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-muted-foreground">
                      <Metric label="Sharpness" value={audit.sharpness_gain} />
                      <Metric label="Detail" value={audit.detail_gain} />
                      <Metric label="Denoise" value={audit.noise_reduction} />
                    </div>
                    <div className="mt-2 text-[11px] text-muted-foreground italic">{audit.verdict}</div>
                  </div>
                )}

                {error && (
                  <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">{error}</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Features */}
        <section id="features" className="mt-16 grid gap-5 md:grid-cols-3">
          <Feature
            title="Real-ESRGAN GPU"
            body="Real generative AI upscaling running on managed GPUs — true detail synthesis, not Lanczos stretching."
            icon="⚡"
          />
          <Feature
            title="AI Quality Auditor"
            body="Gemini compares before/after frames and reports actual sharpness, detail and denoise gains. Catches fake upscalers."
            icon="🛡"
          />
          <Feature
            title="Anti-Piracy Filter"
            body="Every upload is screened for streaming-service watermarks and theater-cam markers before any GPU work."
            icon="©"
          />
        </section>

        {/* How */}
        <section id="how" className="mt-16">
          <h2 className="font-display text-2xl md:text-3xl">How it works</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-5">
            {[
              ["Drop", "Pick a clip up to 60MB."],
              ["AI Scan", "Anti-piracy AI verifies content."],
              ["Upload", "Sent securely to GPU server."],
              ["Real-ESRGAN", "Generative 2-4× upscale on GPU."],
              ["Audit", "AI verifies real enhancement, not fake."],
            ].map(([t, b], i) => (
              <div key={t} className="glass rounded-xl p-5">
                <div className="mb-2 text-[11px] uppercase tracking-[0.25em] text-[#ff7aa3]">Step {i + 1}</div>
                <div className="font-display text-base">{t}</div>
                <div className="mt-1 text-sm text-muted-foreground">{b}</div>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mt-16 grid gap-4 md:grid-cols-2">
          <Faq
            q="Is this real AI or just stretching pixels?"
            a="Real Real-ESRGAN inference on managed GPUs. Our independent Gemini auditor compares before/after frames after every job and shows you the gain numbers — if it's fake, you'll see zeros."
          />
          <Faq
            q="How fast is it?"
            a="A 30-60 second clip typically finishes in 30-90 seconds depending on GPU queue. Way faster than browser-only ffmpeg."
          />
          <Faq
            q="Is my video stored?"
            a="No. Replicate auto-deletes outputs ~1 hour after creation. We don't store anything on our servers. See the Privacy page."
          />
          <Faq
            q="What about copyrighted content?"
            a="An AI screener checks the first frame for streaming-service watermarks and theater-cam patterns and blocks suspected piracy. See Terms & Copyright."
          />
        </section>

        <footer className="mt-16 flex flex-col items-center gap-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link to="/privacy" className="hover:text-foreground">Privacy</Link>
            <span className="opacity-30">·</span>
            <Link to="/terms" className="hover:text-foreground">Terms</Link>
            <span className="opacity-30">·</span>
            <Link to="/copyright" className="hover:text-foreground">Copyright / DMCA</Link>
          </div>
          <div>© {new Date().getFullYear()} NEONUPSCALE · Real GPU AI Video Enhancer</div>
        </footer>
      </section>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={classNames("flex items-center justify-between gap-3 text-sm", disabled && "opacity-60")}>
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={() => !disabled && onChange(!checked)}
        className={classNames(
          "relative h-6 w-11 rounded-full transition-colors",
          checked ? "bg-[#ff0050]" : "bg-white/15",
        )}
        aria-pressed={checked}
        disabled={disabled}
      >
        <span
          className={classNames(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div>
      <div className="font-display text-lg text-foreground tabular-nums">{v}</div>
      <div className="text-[10px] uppercase tracking-widest">{label}</div>
    </div>
  );
}

function Feature({ title, body, icon }: { title: string; body: string; icon: string }) {
  return (
    <div className="glass rounded-xl p-6">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-[#ff0050]/15 text-[#ff0050] neon-border">{icon}</div>
      <div className="font-display text-base">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{body}</div>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <div className="glass rounded-xl p-5">
      <div className="font-display text-sm">{q}</div>
      <div className="mt-1 text-sm text-muted-foreground">{a}</div>
    </div>
  );
}
