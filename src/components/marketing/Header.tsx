import Image from "next/image";
import Link from "next/link";
import { MobileMarketingMenu } from "@/components/marketing/MobileMarketingMenu";
import { siteConfig } from "@/lib/config";
import { getPublicPrimaryCta } from "@/lib/server/app-state";

const marketingNavLinks = [
  { href: "/gmail-cleaner", label: "Gmail" },
  { href: "/outlook-cleaner", label: "Outlook" },
  { href: "/guides", label: "Guides" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" }
];

export async function Header() {
  const cta = await getPublicPrimaryCta();

  return (
    <header className="relative border-b border-[var(--line)] bg-white/95">
      <div className="container flex min-h-20 items-center justify-between gap-6">
        <Link href="/" aria-label="Organizinbox home" className="focus-ring flex items-center gap-3 rounded-md font-extrabold text-[var(--navy)]">
          <Image src={siteConfig.logoPath} alt="Organizinbox" width={44} height={44} priority />
          <span>Organizinbox</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm font-bold text-[var(--navy)] md:flex" aria-label="Marketing navigation">
          {marketingNavLinks.map((link) => (
            <Link className="focus-ring rounded-md px-1 py-2 hover:text-[var(--teal-dark)]" href={link.href} key={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <Link href={cta.href} className="btn btn-primary focus-ring hidden md:inline-flex">
          {cta.label}
        </Link>
        <MobileMarketingMenu cta={cta} links={marketingNavLinks} />
      </div>
    </header>
  );
}
