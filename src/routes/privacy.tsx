import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — NEONUPSCALE" },
      { name: "description", content: "How NEONUPSCALE handles your videos and personal data." },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-foreground">
      <Link to="/" className="text-xs uppercase tracking-widest text-[#ff7aa3] hover:text-foreground">← Back</Link>
      <h1 className="mt-6 font-display text-4xl">Privacy Policy</h1>
      <p className="mt-2 text-xs uppercase tracking-widest text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
      <div className="prose prose-invert mt-8 space-y-5 text-sm text-muted-foreground">
        <p><strong className="text-foreground">Summary:</strong> Your video is sent to a managed AI GPU endpoint (Replicate) only for the duration of enhancement, and is auto-deleted by the provider after processing. We never sell or train on your media.</p>

        <h2 className="font-display text-foreground text-xl">1. What we process</h2>
        <p>When you upload a video to enhance, the file is transmitted over HTTPS to our server function and forwarded to the Replicate API for AI processing (Real-ESRGAN upscaling, RIFE frame interpolation). One sample frame is sent to Lovable AI Gateway (Google Gemini) for the anti-piracy / quality-audit checks described in our Terms.</p>

        <h2 className="font-display text-foreground text-xl">2. Retention</h2>
        <p>Replicate deletes prediction outputs automatically (typically within 1 hour). We do not store your video, frames, or output URLs on our servers. The enhanced video is streamed back to your browser and held in your device memory only.</p>

        <h2 className="font-display text-foreground text-xl">3. No tracking</h2>
        <p>We do not use third-party analytics, advertising cookies, or fingerprinting. The site stores only a single first-visit cookie consent flag in your browser's localStorage.</p>

        <h2 className="font-display text-foreground text-xl">4. AI subprocessors</h2>
        <ul className="list-disc pl-5">
          <li>Replicate, Inc. — GPU inference (Real-ESRGAN, RIFE)</li>
          <li>Google Gemini via Lovable AI Gateway — single-frame moderation & quality audit</li>
        </ul>

        <h2 className="font-display text-foreground text-xl">5. Your rights</h2>
        <p>Because we don't store data, there is nothing to delete on our side. For requests against subprocessors, see Replicate's and Google's privacy policies.</p>

        <h2 className="font-display text-foreground text-xl">6. Contact</h2>
        <p>For privacy questions email <span className="text-foreground">privacy@neonupscale.app</span>.</p>
      </div>
    </div>
  );
}
