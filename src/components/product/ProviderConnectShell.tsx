import type { ReactNode } from "react";
import Link from "next/link";
import { Footer } from "@/components/marketing/Footer";
import { Header } from "@/components/marketing/Header";
import { ContextBackAction } from "@/components/product/ContextBackAction";

type ProviderConnectShellProps = {
  backHref?: string;
  backLabel?: string;
  description: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
};

const trustItems = [
  "Doesn't read email bodies",
  "Doesn't download attachments",
  "Doesn't send email",
  "Never permanently deletes email"
];

export function ProviderConnectShell({
  backHref = "/connect",
  backLabel = "Back to provider selection",
  description,
  eyebrow,
  title,
  children
}: ProviderConnectShellProps) {
  return (
    <>
      <Header />
      <main className="section">
        <div className="container max-w-5xl">
          <ContextBackAction className="mb-7" href={backHref} label={backLabel} />
          <div className="mx-auto max-w-2xl text-center">
            <p className="eyebrow">{eyebrow}</p>
            <h1 className="section-title mt-3">{title}</h1>
            <p className="muted mx-auto mt-4 max-w-xl text-lg leading-8">{description}</p>
          </div>
          <div className="mx-auto mt-8 grid max-w-4xl gap-7 md:grid-cols-[minmax(0,1.15fr)_minmax(17rem,0.85fr)] md:items-start">
            <section className="panel p-6 md:p-7">{children}</section>
            <aside className="border-t border-[var(--line)] pt-6 md:border-l md:border-t-0 md:pl-7 md:pt-1" aria-labelledby="connection-trust-title">
              <p className="eyebrow">Your inbox stays yours</p>
              <h2 className="m-0 mt-2 text-xl font-extrabold text-[var(--navy)]" id="connection-trust-title">
                Organizinbox
              </h2>
              <ul className="mt-5 grid gap-3 p-0 text-sm font-bold text-[var(--navy)]">
                {trustItems.map((item) => (
                  <li className="flex items-start gap-3" key={item}>
                    <span className="mt-0.5 text-[var(--teal-dark)]" aria-hidden="true">{"\u2713"}</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <Link className="focus-ring mt-6 inline-flex rounded-md py-2 text-sm font-bold text-[var(--teal-dark)] hover:underline" href="/data-access">
                How data access works
              </Link>
            </aside>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
