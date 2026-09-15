import Link from "next/link";

export function ProviderUnavailable({ provider }: { provider?: "gmail" | "microsoft" }) {
  const label = provider === "gmail" ? "Gmail" : provider === "microsoft" ? "Outlook" : "Inbox scanning";
  return (
    <section className="mt-6 border-t border-[var(--line)] py-6">
      <h2 className="m-0 text-2xl font-bold">{label} is temporarily unavailable</h2>
      <p className="muted mt-3">Connection and scanning are paused. This does not disconnect your inbox or clear your saved report. Cleanup is not available.</p>
      <Link className="btn btn-secondary focus-ring mt-3" href="/connect">View provider availability</Link>
    </section>
  );
}
