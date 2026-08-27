import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { AppFooter } from "@/components/product/AppFooter";
import { siteConfig } from "@/lib/config";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";

export const metadata: Metadata = {
  title: "Inbox Report",
  robots: {
    index: false,
    follow: false
  }
};

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const connection = await getCurrentProviderConnection();

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b border-[var(--line)] bg-white">
        <div className="container flex min-h-20 flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="Organizinbox home" className="focus-ring flex items-center gap-3 rounded-md font-extrabold text-[var(--navy)]">
            <Image src={siteConfig.logoPath} alt="Organizinbox" width={40} height={40} priority />
            <span>Organizinbox</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--navy)]" aria-label="Application navigation">
            {connection.mode === "connected" ? <span className="badge">Gmail connected</span> : null}
            <Link className="rounded-md px-3 py-2 hover:bg-[var(--soft)]" href="/app/help">
              Help
            </Link>
            <Link className="rounded-md px-3 py-2 hover:bg-[var(--soft)]" href="/app/account">
              Account
            </Link>
          </nav>
        </div>
      </header>
      <div className="min-h-[calc(100vh-18rem)]">{children}</div>
      <AppFooter />
    </div>
  );
}
