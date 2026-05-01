import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/copyright")({
  head: () => ({
    meta: [
      { title: "Copyright & DMCA — NEONUPSCALE" },
      { name: "description", content: "DMCA takedown notice procedure for the NEONUPSCALE AI video enhancer." },
    ],
  }),
  component: CopyrightPage,
});

function CopyrightPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-foreground">
      <Link to="/" className="text-xs uppercase tracking-widest text-[#ff7aa3] hover:text-foreground">← Back</Link>
      <h1 className="mt-6 font-display text-4xl">Copyright & DMCA Policy</h1>
      <p className="mt-2 text-xs uppercase tracking-widest text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
      <div className="mt-8 space-y-5 text-sm text-muted-foreground">
        <h2 className="font-display text-foreground text-xl">Notice & takedown</h2>
        <p>NEONUPSCALE does not store user-uploaded videos — outputs are auto-deleted by our processing provider within ~1 hour. Nevertheless, we honor copyright holders. If you believe content is being processed in violation of your rights, send a DMCA-style notice including:</p>
        <ol className="list-decimal pl-5">
          <li>Identification of the copyrighted work claimed to be infringed.</li>
          <li>Sufficient detail to locate the alleged infringement (URL, screenshot, timestamp).</li>
          <li>Your contact information (name, address, phone, email).</li>
          <li>A statement, under penalty of perjury, that you are the rights owner or authorized to act on their behalf, and that the use is not authorized.</li>
          <li>Your physical or electronic signature.</li>
        </ol>
        <p>Send notices to: <strong className="text-foreground">dmca@neonupscale.app</strong></p>

        <h2 className="font-display text-foreground text-xl">Counter-notice</h2>
        <p>If you believe your content was wrongly removed, you may submit a counter-notice with the same level of detail. We forward verified counter-notices to the original complainant.</p>

        <h2 className="font-display text-foreground text-xl">Repeat-infringer policy</h2>
        <p>We terminate access for users who are the subject of repeat substantiated infringement notices.</p>

        <h2 className="font-display text-foreground text-xl">Anti-piracy enforcement</h2>
        <p>An AI moderation pass screens a sample frame of every upload for streaming-service watermarks, broadcaster overlays, and theater-cam recordings. Suspected piracy is blocked before any GPU work runs. This is a best-effort system, not a guarantee.</p>
      </div>
    </div>
  );
}
