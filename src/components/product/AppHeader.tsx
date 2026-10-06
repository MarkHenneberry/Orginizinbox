"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";

export function AppHeader({ provider, availableCredits, reportAvailable, scanAvailable, cleanupAvailable, cleanupStartAvailable = false, logoPath }: {
  logoPath: string;
  provider?: "gmail" | "microsoft";
  availableCredits: number | null;
  reportAvailable: boolean;
  scanAvailable: boolean;
  cleanupAvailable: boolean;
  cleanupStartAvailable?: boolean;
}) {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  const onReport = path === "/app/report";
  const workflow = [
    ...(reportAvailable || onReport ? [{ href: "/app/report", label: "Inbox Report" }] : scanAvailable ? [{ href: "/app/scan", label: "Scan inbox" }] : []),
    ...(cleanupAvailable || (onReport && cleanupStartAvailable) || path === "/app/cleanup" ? [{ href: "/app/cleanup", label: "Cleanup" }] : [])
  ];
  const creditLabel = availableCredits === null ? "Credits" : `${availableCredits.toLocaleString("en-US")} credits`;
  function close() { if (menu.current) menu.current.open = false; }
  return <header className="product-header">
    <div className="container app-header-inner">
      <Link href="/" aria-label="Organizinbox home" className="app-brand focus-ring">
        <Image src={logoPath} alt="" width={34} height={34} priority />
        <span>Organizinbox</span>
      </Link>
      <nav className="app-workflow-nav" aria-label="Application navigation">
        {workflow.map((item) => <Link key={item.href} href={item.href} aria-current={path === item.href ? "page" : undefined}>{item.label}</Link>)}
      </nav>
      <Link className="header-credits focus-ring" href="/app/credits" aria-label={`${creditLabel}, manage credits`}>{creditLabel}</Link>
      <details className="account-menu" ref={menu} onKeyDown={(event) => {
        if (event.key === "Escape") { close(); menu.current?.querySelector("summary")?.focus(); }
      }}>
        <summary className="focus-ring"><span>{provider === "gmail" ? "Gmail" : provider === "microsoft" ? "Microsoft" : "Account"}</span><span aria-hidden="true">⌄</span></summary>
        <nav className="account-menu-items" aria-label="Account and mobile navigation" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) close(); }}>
          {provider ? <p className="menu-caption">{provider === "gmail" ? "Gmail" : "Microsoft"} connected</p> : null}
          <div className="mobile-workflow-nav">{workflow.map((item) => <Link key={item.href} href={item.href} aria-current={path === item.href ? "page" : undefined}>{item.label}</Link>)}</div>
          <Link href="/app/credits" aria-current={path === "/app/credits" ? "page" : undefined}>Manage credits</Link>
          <Link href="/app/account" aria-current={path === "/app/account" ? "page" : undefined}>Account</Link>
          <Link href="/app/help" aria-current={path === "/app/help" ? "page" : undefined}>Help</Link>
          <div className="menu-divider" />
          <Link href="/app/security">Security</Link>
          <Link href="/app/data-access">Data access</Link>
          <Link href="/app/privacy">Privacy</Link>
        </nav>
      </details>
    </div>
  </header>;
}
