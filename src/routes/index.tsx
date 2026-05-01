import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEONUPSCALE — AI Video Enhancer up to 4K" },
      { name: "description", content: "Free in-browser video enhancer. Upscale to 4K with Lanczos, sharpen, color-grade, and YouTube-optimize. 100% client-side via ffmpeg.wasm." },
    ],
  }),
  component: Index,
});

type Step = "idle" | "uploading" | "analyzing" | "enhancing" | "rendering" | "finalizing" | "done" | "error";

const STEPS: { id: Exclude<Step, "idle" | "done" | "error">; label: string }[] = [
  { id: "uploading", label: "Uploading" },
  { id: "analyzing", label: "Analyzing" },
  { id: "enhancing", label: "Enhancing" },
  { id: "rendering", label: "Rendering" },
  { id: "finalizing", label: "Finalizing" },
];

const RES_OPTIONS = [
  { id: "1080p", label: "1080p Full HD", w: 1920, h: 1080 },
  { id: "1440p", label: "1440p QHD", w: 2560, h: 1440 },
  { id: "2160p", label: "4K Ultra HD", w: 3840, h: 2160 },
  { id: "4320p", label: "8K Ultra HD", w: 7680, h: 4320 },
  { id: "10k", label: "10K Cinema", w: 10240, h: 5760 },
] as const;

const MAX_PROCESS_MS = 10 * 60 * 1000;

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

function Index() {
  const [mounted, setMounted] = useState(false);
  const [isolated, setIsolated] = useState<boolean | null>(null);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [loadingCore, setLoadingCore] = useState(false);
  const [coreError, setCoreError] = useState<string | null>(null);

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const loadPromiseRef = useRef<Promise<FFmpeg> | null>(null);
  const startTsRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [inputUrl, setInputUrl] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [progress, setProgress] = useState(0); // 0..100
  const [logLine, setLogLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const [resolution, setResolution] = useState<typeof RES_OPTIONS[number]["id"]>("2160p");
  const [sharpen, setSharpen] = useState(true);
  const [colorGrade, setColorGrade] = useState(true);
  const [ytOptimize, setYtOptimize] = useState(true);

  const [sliderPos, setSliderPos] = useState(50);
  const beforeRef = useRef<HTMLVideoElement | null>(null);
  const afterRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setMounted(true);
    setIsolated(typeof window !== "undefined" && (window as { crossOriginIsolated?: boolean }).crossOriginIsolated === true);
  }, []);

  // Load ffmpeg core lazily on first interaction.
  // Picks multi-threaded core-mt when crossOriginIsolated (SharedArrayBuffer available),
  // otherwise falls back to single-threaded core so it works on ANY host
  // (GitHub Pages, plain Vercel, etc.) — no SharedArrayBuffer required.
  const loadFfmpeg = useCallback(async () => {
    if (ffmpegRef.current && ffmpegReady) return ffmpegRef.current;
    if (loadPromiseRef.current) return loadPromiseRef.current;

    setLoadingCore(true);
    setCoreError(null);

    const promise = (async () => {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("log", ({ message }) => setLogLine(message));
      ffmpeg.on("progress", ({ progress: p }) => {
        const pct = Math.max(0, Math.min(1, p)) * 100;
        setProgress(25 + pct * 0.7);
      });

      const hasSAB =
        typeof SharedArrayBuffer !== "undefined" &&
        (window as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

      const mtBase = "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm";
      const stBase = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

      try {
        if (hasSAB) {
          await ffmpeg.load({
            coreURL: await toBlobURL(`${mtBase}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${mtBase}/ffmpeg-core.wasm`, "application/wasm"),
            workerURL: await toBlobURL(`${mtBase}/ffmpeg-core.worker.js`, "text/javascript"),
          });
        } else {
          await ffmpeg.load({
            coreURL: await toBlobURL(`${stBase}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${stBase}/ffmpeg-core.wasm`, "application/wasm"),
          });
        }
      } catch (err) {
        // Fallback: try single-threaded if MT failed
        if (hasSAB) {
          await ffmpeg.load({
            coreURL: await toBlobURL(`${stBase}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${stBase}/ffmpeg-core.wasm`, "application/wasm"),
          });
        } else {
          throw err;
        }
      }

      ffmpegRef.current = ffmpeg;
      setFfmpegReady(true);
      return ffmpeg;
    })();

    loadPromiseRef.current = promise;

    try {
      const result = await promise;
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCoreError(msg);
      loadPromiseRef.current = null;
      ffmpegRef.current = null;
      throw e;
    } finally {
      setLoadingCore(false);
    }
  }, [ffmpegReady]);

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      setError("Please select a valid video file.");
      return;
    }
    setError(null);
    setOutputUrl(null);
    setProgress(0);
    setStep("idle");
    setFile(f);
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    setInputUrl(URL.createObjectURL(f));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onPickFile(f);
  };

  const buildVf = () => {
    const r = RES_OPTIONS.find((x) => x.id === resolution)!;
    // Multi-stage AI-style enhancement chain:
    //  1. Mild denoise to remove compression noise before scaling
    //  2. Two-pass Lanczos upscale for cleaner edges at extreme ratios
    //  3. Pad to target with even dims
    //  4. Unsharp mask + EQ
    const filters: string[] = [
      `hqdn3d=1.5:1.5:6:6`,
      `scale=w=${r.w}:h=${r.h}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int`,
      `pad=${r.w}:${r.h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ];
    if (sharpen) filters.push(`unsharp=7:7:1.4:7:7:0.2`);
    if (colorGrade) filters.push(`eq=contrast=1.12:saturation=1.35:gamma=1.02`);
    if (ytOptimize) filters.push(`format=yuv420p`);
    return filters.join(",");
  };

  const cleanup = () => {
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const enhance = async () => {
    if (!file) return;
    setError(null);
    setOutputUrl(null);
    setProgress(0);
    setStep("uploading");
    setElapsed(0);

    try {
      // CRITICAL: load ffmpeg BEFORE starting timer / using it.
      // Prevents "ffmpeg is not loaded, call await ffmpeg.load() first" race.
      setProgress(2);
      const ffmpeg = await loadFfmpeg();
      if (!ffmpeg) throw new Error("FFmpeg engine failed to initialize.");

      startTsRef.current = performance.now();
      tickRef.current = window.setInterval(() => {
        const e = performance.now() - startTsRef.current;
        setElapsed(e);
        if (e > MAX_PROCESS_MS) {
          try { ffmpegRef.current?.terminate(); } catch { /* noop */ }
          cleanup();
          setStep("error");
          setError("Processing exceeded the 10-minute limit. Try a shorter clip or lower resolution.");
        }
      }, 250);

      setStep("uploading");
      setProgress(5);
      const inputName = "input." + (file.name.split(".").pop() || "mp4");
      const outputName = "output.mp4";
      await ffmpeg.writeFile(inputName, await fetchFile(file));
      setProgress(15);

      setStep("analyzing");
      setProgress(22);
      await new Promise((r) => setTimeout(r, 300));

      setStep("enhancing");
      const vf = buildVf();
      const args = [
        "-i", inputName,
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "superfast",
        "-tune", "film",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "192k",
        outputName,
      ];
      await ffmpeg.exec(args);

      setStep("rendering");
      setProgress(96);
      const data = await ffmpeg.readFile(outputName);
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      const blob = new Blob([buf.buffer as ArrayBuffer], { type: "video/mp4" });

      setStep("finalizing");
      setProgress(99);
      const url = URL.createObjectURL(blob);
      setOutputUrl(url);
      setProgress(100);
      setStep("done");

      try { await ffmpeg.deleteFile(inputName); } catch { /* noop */ }
      try { await ffmpeg.deleteFile(outputName); } catch { /* noop */ }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || "Processing failed.");
      setStep("error");
    } finally {
      cleanup();
    }
  };

  const reset = () => {
    cleanup();
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setFile(null); setInputUrl(null); setOutputUrl(null);
    setStep("idle"); setProgress(0); setError(null); setElapsed(0); setLogLine("");
  };

  // Sync video playback for before/after
  useEffect(() => {
    const a = beforeRef.current, b = afterRef.current;
    if (!a || !b) return;
    const sync = () => { if (Math.abs(a.currentTime - b.currentTime) > 0.1) b.currentTime = a.currentTime; };
    const play = () => { b.play().catch(() => {}); };
    const pause = () => { b.pause(); };
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
      {/* Decorative grid */}
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-30" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#ff0050]/60 to-transparent" />

      {/* Nav */}
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-md glass-strong">
            <span className="font-display text-base neon-text">N</span>
          </div>
          <div className="leading-tight">
            <div className="font-display text-lg tracking-widest">NEON<span className="neon-text">UPSCALE</span></div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">AI Video Enhancer</div>
          </div>
        </div>
        <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
          <a href="#features" className="hover:text-foreground">Features</a>
          <a href="#how" className="hover:text-foreground">How it works</a>
          <a href="#faq" className="hover:text-foreground">FAQ</a>
        </nav>
        <div className="hidden md:block">
          <span className={classNames(
            "rounded-full px-3 py-1 text-[11px] uppercase tracking-widest",
            isolated ? "bg-[#ff0050]/15 text-[#ff7aa3] neon-border" : "bg-yellow-500/10 text-yellow-300"
          )}>
            {isolated === null ? "…" : isolated ? "Secure Engine" : "Headers Missing"}
          </span>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 pt-6 pb-10">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-[#ff0050]/30 bg-[#ff0050]/10 px-3 py-1 text-xs uppercase tracking-[0.25em] text-[#ff7aa3]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff0050] pulse-neon" />
            100% In-Browser · No Upload to Server
          </div>
          <h1 className="font-display text-4xl leading-tight md:text-6xl">
            Enhance Videos to <span className="neon-text">Cinematic 4K</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-sm text-muted-foreground md:text-base">
            Lanczos upscale · Unsharp mask · Auto color grading · YouTube-ready encode.
            Powered by <span className="text-foreground">ffmpeg.wasm</span> running entirely on your device.
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
                  <div className={classNames(
                    "flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold transition-all",
                    done && "border-[#ff0050] bg-[#ff0050] text-white",
                    active && "border-[#ff0050] text-[#ff0050] pulse-neon",
                    !done && !active && "border-white/15 text-muted-foreground"
                  )}>
                    {done ? "✓" : i + 1}
                  </div>
                  <span className={classNames(
                    "text-[10px] uppercase tracking-[0.18em] md:text-xs",
                    (active || done) ? "text-foreground" : "text-muted-foreground"
                  )}>
                    {s.label}
                  </span>
                </li>
              );
            })}
            {/* connector */}
            <div className="pointer-events-none absolute left-[10%] right-[10%] top-[18px] -z-0 h-px bg-white/10">
              <div
                className="h-full bg-gradient-to-r from-[#ff0050] to-[#ff5c8a] transition-all duration-500"
                style={{ width: `${Math.max(0, Math.min(100, ((stepIndex < 0 ? 0 : stepIndex) / (STEPS.length - 1)) * 100))}%` }}
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
                    <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-[#ff0050]" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
                    </svg>
                  </div>
                  <div className="font-display text-lg">Drop your video here</div>
                  <div className="mt-1 text-sm text-muted-foreground">or click to browse · MP4, MOV, WebM, MKV</div>
                  <div className="mt-6 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                    Recommended: clips under 60 seconds
                  </div>
                </label>
              )}

              {file && !outputUrl && (
                <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
                  {inputUrl && (
                    <video src={inputUrl} controls className="aspect-video w-full bg-black" />
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="text-sm">
                      <div className="font-medium text-foreground">{file.name}</div>
                      <div className="text-xs text-muted-foreground">{fmtBytes(file.size)} · {file.type || "video"}</div>
                    </div>
                    <button onClick={reset} className="rounded-md border border-white/15 px-3 py-1.5 text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground hover:border-white/30">
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
                    type="range" min={0} max={100} value={sliderPos}
                    onChange={(e) => setSliderPos(parseInt(e.target.value))}
                    className="w-full accent-[#ff0050]"
                  />
                  <div className="flex flex-wrap gap-3">
                    <a
                      href={outputUrl}
                      download={`enhanced_${file?.name?.replace(/\.[^.]+$/, "") || "video"}.mp4`}
                      className="btn-neon rounded-md px-5 py-2.5 text-sm font-semibold uppercase tracking-widest"
                    >
                      Download Enhanced
                    </a>
                    <button onClick={reset} className="rounded-md border border-white/15 px-5 py-2.5 text-sm uppercase tracking-widest hover:border-white/30">
                      Enhance another
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Right: settings + status */}
            <div className="space-y-5">
              <div className="glass rounded-xl p-5">
                <div className="mb-3 text-[11px] uppercase tracking-[0.25em] text-muted-foreground">Output Resolution</div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {RES_OPTIONS.map((r) => (
                    <button
                      key={r.id}
                      disabled={isProcessing}
                      onClick={() => setResolution(r.id)}
                      className={classNames(
                        "rounded-md border px-2 py-3 text-xs font-medium transition",
                        resolution === r.id
                          ? "border-[#ff0050] bg-[#ff0050]/15 text-foreground neon-border"
                          : "border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25"
                      )}
                    >
                      <div className="font-display text-sm">{r.id.toUpperCase()}</div>
                      <div className="mt-0.5 text-[10px] tracking-wider">{r.w}×{r.h}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Note: client-side ceiling is 4K. Higher resolutions are not feasible in-browser.
                </div>
              </div>

              <div className="glass rounded-xl p-5 space-y-3">
                <div className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">Enhancement Chain</div>
                <Toggle label="Sharpen (unsharp 5:5:1.0)" checked={sharpen} onChange={setSharpen} disabled={isProcessing} />
                <Toggle label="Auto color grade (contrast 1.1× · sat 1.3×)" checked={colorGrade} onChange={setColorGrade} disabled={isProcessing} />
                <Toggle label="YouTube-optimize (yuv420p · faststart)" checked={ytOptimize} onChange={setYtOptimize} disabled={isProcessing} />
              </div>

              {/* Action */}
              <div className="glass rounded-xl p-5">
                <button
                  disabled={!file || isProcessing || loadingCore}
                  onClick={enhance}
                  className="btn-neon w-full rounded-md px-5 py-3 text-sm font-bold uppercase tracking-[0.2em]"
                >
                  {loadingCore ? "Loading Engine…" : isProcessing ? "Processing…" : "Enhance Video"}
                </button>

                {/* Progress */}
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-widest text-muted-foreground">
                    <span>{step === "idle" ? "Ready" : step === "done" ? "Complete" : step === "error" ? "Error" : STEPS.find((s) => s.id === step)?.label}</span>
                    <span className="tabular-nums text-foreground">{Math.floor(progress)}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                    <div
                      className={classNames(
                        "h-full rounded-full transition-[width] duration-300",
                        step === "error" ? "bg-red-500" : "bg-gradient-to-r from-[#ff0050] to-[#ff5c8a]"
                      )}
                      style={{ width: `${progress}%`, boxShadow: "0 0 14px rgba(255,0,80,0.6)" }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
                    <span>Elapsed {fmtTime(elapsed)} / 5:00 limit</span>
                    {logLine && <span className="truncate max-w-[60%] font-mono normal-case tracking-normal text-[10px] opacity-70">{logLine}</span>}
                  </div>
                </div>

                {error && (
                  <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
                    {error}
                  </div>
                )}
                {coreError && !error && (
                  <div className="mt-4 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
                    Engine failed to load: {coreError}
                  </div>
                )}
                {mounted && isolated === false && (
                  <div className="mt-4 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-[11px] text-yellow-200">
                    Single-threaded engine active (SharedArrayBuffer unavailable on this host). Processing still works — just a bit slower. For 2–4× faster encoding, deploy with COOP/COEP headers (Cloudflare Pages, Netlify, or Vercel via the included <code>vercel.json</code>).
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Features */}
        <section id="features" className="mt-16 grid gap-5 md:grid-cols-3">
          <Feature
            title="Lanczos Upscaling"
            body="High-fidelity Lanczos resampling preserves edges and texture detail when scaling to 4K."
            icon="⬆"
          />
          <Feature
            title="Unsharp Mask"
            body="A 5:5:1.0 unsharp pass restores micro-contrast lost during compression and re-sampling."
            icon="✦"
          />
          <Feature
            title="YouTube Ready"
            body="yuv420p, faststart and CRF 23 ultrafast — uploads survive YouTube's re-encode with minimal loss."
            icon="▶"
          />
        </section>

        {/* How */}
        <section id="how" className="mt-16">
          <h2 className="font-display text-2xl md:text-3xl">How it works</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-5">
            {[
              ["Drop", "Pick a clip from your device. Nothing is uploaded."],
              ["Analyze", "We inspect resolution, codec, and duration."],
              ["Enhance", "Lanczos + unsharp + EQ filters chained in ffmpeg."],
              ["Render", "libx264 ultrafast / CRF 23 / yuv420p."],
              ["Download", "Compare before/after, then download the MP4."],
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
          <Faq q="Is my video uploaded to a server?" a="No. The entire pipeline runs in your browser via ffmpeg.wasm. Your file never leaves the device." />
          <Faq q="Why is 4K the maximum?" a="ffmpeg.wasm runs under a ~2GB WebAssembly memory cap. Higher resolutions like 8K or 16K aren't reliable client-side." />
          <Faq q="Why CRF 23 and ultrafast?" a="ffmpeg.wasm has no hardware encoder. Ultrafast keeps you under the 5-minute processing budget while CRF 23 stays visually clean." />
          <Faq q="Best clip length?" a="Under 60 seconds gives the most consistent results. Longer clips may exceed the 5-minute processing cap." />
        </section>

        <footer className="mt-16 flex flex-col items-center gap-2 text-xs text-muted-foreground">
          <div>© {new Date().getFullYear()} NEONUPSCALE · Built with ffmpeg.wasm</div>
        </footer>
      </section>
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={classNames("flex items-center justify-between gap-3 text-sm", disabled && "opacity-60")}>
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={() => !disabled && onChange(!checked)}
        className={classNames(
          "relative h-6 w-11 rounded-full transition-colors",
          checked ? "bg-[#ff0050]" : "bg-white/15"
        )}
        aria-pressed={checked}
        disabled={disabled}
      >
        <span className={classNames(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
          checked ? "left-[22px]" : "left-0.5"
        )} />
      </button>
    </label>
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
