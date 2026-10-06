import Link from "next/link";

export function AppFooter() {
  return (
    <footer className="app-utility-footer">
      <div className="container flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="m-0 font-extrabold text-[var(--navy)]">Organizinbox</p>
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
