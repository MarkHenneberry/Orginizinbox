import Link from "next/link";

export function AppFooter() {
  return (
    <footer className="border-t border-[var(--line)] bg-white py-10">
      <div className="container grid gap-6 md:grid-cols-[1fr_auto]">
        <div>
          <p className="m-0 font-extrabold text-[var(--navy)]">Organizinbox</p>
          <p className="muted mt-2 max-w-2xl">
            Your active inbox session stays in the app while you review account, help, security, and data-access information.
          </p>
        </div>
        <nav className="flex flex-wrap gap-4 text-sm font-bold text-[var(--navy)]" aria-label="Application footer navigation">
          <Link href="/">Home</Link>
          <Link href="/app/data-access">Data Access</Link>
          <Link href="/app/security">Security</Link>
          <Link href="/app/help">Help</Link>
          <Link href="/app/privacy">Privacy</Link>
        </nav>
      </div>
    </footer>
  );
}
