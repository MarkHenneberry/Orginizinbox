"use client";

import Link from "next/link";
import { useState } from "react";

export type MarketingNavLink = {
  href: string;
  label: string;
};

export function MobileMarketingMenu({ links, cta }: { links: MarketingNavLink[]; cta: MarketingNavLink }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        aria-controls="mobile-marketing-navigation"
        aria-expanded={open}
        className="btn btn-secondary focus-ring min-w-24"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? "Close" : "Menu"}
      </button>
      <nav
        aria-label="Mobile marketing navigation"
        className={`${open ? "grid" : "hidden"} absolute left-4 right-4 top-20 z-20 gap-2 rounded-md border border-[var(--line)] bg-white p-4 shadow-lg`}
        id="mobile-marketing-navigation"
      >
        {links.map((link) => (
          <Link className="focus-ring rounded-md px-3 py-3 text-sm font-bold text-[var(--navy)] hover:bg-[var(--soft)]" href={link.href} key={link.href} onClick={() => setOpen(false)}>
            {link.label}
          </Link>
        ))}
        <Link className="btn btn-primary focus-ring mt-2" href={cta.href} onClick={() => setOpen(false)}>
          {cta.label}
        </Link>
      </nav>
    </div>
  );
}
