import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — NEONUPSCALE" },
      { name: "description", content: "Acceptable use, prohibited content, and liability for the NEONUPSCALE AI video enhancer." },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-foreground">
      <Link to="/" className="text-xs uppercase tracking-widest text-[#ff7aa3] hover:text-foreground">← Back</Link>
      <h1 className="mt-6 font-display text-4xl">Terms of Service</h1>
      <p className="mt-2 text-xs uppercase tracking-widest text-muted-foreground">Last updated: {new Date().toLocaleDateString()}</p>
      <div className="mt-8 space-y-5 text-sm text-muted-foreground">
        <h2 className="font-display text-foreground text-xl">1. Acceptable use</h2>
        <p>You may upload videos only if (a) you own them, (b) you have explicit permission from the copyright holder, or (c) the content is in the public domain. By using NEONUPSCALE you assert one of these is true.</p>

        <h2 className="font-display text-foreground text-xl">2. Prohibited content</h2>
        <ul className="list-disc pl-5">
          <li>Pirated movies, TV episodes, or sports broadcasts (theater-cam recordings, streaming-service rips)</li>
          <li>CSAM, non-consensual intimate imagery, or content sexualising minors</li>
          <li>Realistic deepfakes of real people without their consent</li>
          <li>Content depicting graphic violence, terrorism, or illegal activity</li>
          <li>Content infringing trademarks (logos, broadcaster watermarks)</li>
        </ul>
        <p>Our anti-piracy AI screens a sample frame from each upload. Detected violations are blocked client-side before any GPU processing is billed.</p>

        <h2 className="font-display text-foreground text-xl">3. AI output</h2>
        <p>AI enhancement is best-effort. We do not guarantee a specific quality, frame rate, or processing time. Outputs are provided "as is" with no warranty of fitness for any particular purpose.</p>

        <h2 className="font-display text-foreground text-xl">4. Liability</h2>
        <p>NEONUPSCALE is provided free for personal use. To the maximum extent permitted by law we disclaim all liability for indirect, incidental, or consequential damages arising from use of the service.</p>

        <h2 className="font-display text-foreground text-xl">5. Termination</h2>
        <p>We may suspend access for any user who repeatedly uploads prohibited content or attempts to bypass our anti-piracy checks.</p>

        <h2 className="font-display text-foreground text-xl">6. Governing law</h2>
        <p>These terms are governed by the laws of the user's jurisdiction of residence to the extent required by mandatory consumer-protection rules; otherwise by the laws applicable where the service operator is established.</p>

        <h2 className="font-display text-foreground text-xl">7. Changes</h2>
        <p>We may revise these terms. Continued use of the service after a revision constitutes acceptance.</p>
      </div>
    </div>
  );
}
