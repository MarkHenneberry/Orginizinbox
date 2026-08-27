import Link from "next/link";
import { siteConfig } from "@/lib/config";

const footerGroups = [
  {
    title: "Product",
    links: [
      { href: "/gmail-cleaner", label: "Gmail Cleaner" },
      { href: "/outlook-cleaner", label: "Outlook Cleaner" },
      { href: "/pricing", label: "Pricing" },
      { href: "/#how-it-works", label: "How it works" }
    ]
  },
  {
    title: "Guides",
    links: [
      { href: "/guides", label: "Guides" },
      { href: "/delete-old-emails", label: "Delete old emails" },
      { href: "/delete-emails-by-sender", label: "Delete by sender" },
      { href: "/delete-newsletters", label: "Delete newsletters" },
      { href: "/free-up-gmail-storage", label: "Free up Gmail storage" },
      { href: "/inbox-reset", label: "Inbox reset" }
    ]
  },
  {
    title: "Trust",
    links: [
      { href: "/security", label: "Security" },
      { href: "/data-access", label: "Data Access" },
      { href: "/privacy", label: "Privacy" }
    ]
  },
  {
    title: "Company",
    links: [{ href: "/about", label: "About" }]
  }
];

export function Footer() {
  return (
    <footer className="border-t border-[var(--line)] bg-white py-10">
      <div className="container grid gap-8 lg:grid-cols-[1.2fr_2fr]">
        <div>
          <Link href="/" aria-label="Organizinbox home" className="focus-ring inline-flex rounded-md font-extrabold text-[var(--navy)]">
            {siteConfig.name}
          </Link>
          <p className="muted mt-2 max-w-2xl">
            See what&apos;s clogging your inbox, then move unwanted email to Trash. Nothing is permanently deleted.
          </p>
        </div>
        <nav className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4" aria-label="Footer navigation">
          {footerGroups.map((group) => (
            <section key={group.title}>
              <h2 className="m-0 text-sm font-extrabold text-[var(--navy)]">{group.title}</h2>
              <ul className="mt-3 grid gap-2 p-0 text-sm">
                {group.links.map((link) => (
                  <li className="list-none" key={link.href}>
                    <Link className="focus-ring rounded-md text-[var(--muted)] hover:text-[var(--navy)]" href={link.href}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </div>
    </footer>
  );
}
