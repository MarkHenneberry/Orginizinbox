import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("product copy and contextual navigation", () => {
  it("documents the copy system before implementation details", () => {
    const spec = read("organizinbox-specs.md");

    expect(spec).toMatch(/## Product Copy System/);
    expect(spec).toMatch(/See what's clogging your inbox/);
    expect(spec).toMatch(/Clean thousands of unwanted emails safely/);
    expect(spec).toMatch(/Nothing is permanently deleted/);
    expect(spec).toMatch(/When we're unsure, we leave it alone/);
    expect(spec).toMatch(/Primary:[\s\S]+Secondary:[\s\S]+Tertiary:/);
  });

  it("keeps canonical public CTAs session-aware", () => {
    const state = read("src/lib/server/app-state.ts");

    expect(state).toMatch(/connected_active_report[\s\S]+label: "Return to Inbox Report"/);
    expect(state).toMatch(/connected_no_report[\s\S]+label: "Scan my inbox"/);
    expect(state).toMatch(/needs_reconnect[\s\S]+label: "Reconnect Gmail"/);
    expect(state).toMatch(/label: "Clean my inbox"/);
    expect(state).not.toMatch(/Clean my Gmail/);
  });

  it("uses simple homepage, workflow, and protection copy", () => {
    const home = read("app/page.tsx");

    expect(home).toMatch(/See what&apos;s clogging your inbox/);
    expect(home).toMatch(/finds the senders and old email taking over your inbox/);
    expect(home).toMatch(/Nothing is permanently deleted/);
    expect(home).toMatch(/Connect Gmail securely/);
    expect(home).toMatch(/See what&apos;s filling your inbox/);
    expect(home).toMatch(/Check what Organizinbox recommends cleaning/);
    expect(home).toMatch(/Move unwanted email to Trash in a few clicks/);
    expect(home).toMatch(/When we&apos;re unsure, we leave it alone/);
  });

  it("keeps connect and retry copy plain while preserving fresh OAuth actions", () => {
    const connect = read("app/connect/google/page.tsx");
    const error = read("app/connect/google/error/page.tsx");

    expect(connect).toMatch(/Connect Gmail/);
    expect(connect).toMatch(/move messages you approve to Trash/);
    expect(connect).toMatch(/href="\/data-access"/);
    expect(connect).toMatch(/ContextBackAction[^>]+href="\/"[^>]+label="Back to homepage"/);
    expect(error).toMatch(/Gmail didn't finish connecting/);
    expect(error).toMatch(/Try again and approve Gmail access when Google asks/);
    expect(error).toMatch(/Try connecting Gmail again/);
    expect(error).toMatch(/action="\/api\/oauth\/google\/start"/);
    expect(error).not.toMatch(/Gmail IMAP permission was not granted/);
  });

  it("describes the report as decisions with plain recommendation labels", () => {
    const report = read("src/components/product/InboxReportView.tsx");

    expect(report).toMatch(/Emails you may want to clean/);
    expect(report).toMatch(/Several independent bulk-mail signals agree/);
    expect(report).toMatch(/Recurring old mail has strong bulk-mail evidence/);
    expect(report).toMatch(/Review only\. No messages in this group are suggested for cleanup/);
    expect(report).toMatch(/We found signs these messages may be important/);
    expect(report).toMatch(/When we&apos;re unsure, we leave them alone/);
    expect(report).not.toMatch(/confidence percentage|cleanup candidates/i);
  });

  it("uses Suggested for the cleanup bucket while preserving internal Ready and Recommendation", () => {
    const report = read("src/components/product/InboxReportView.tsx");
    const cleanup = read("src/components/product/GmailCleanupClient.tsx");
    const preview = read("src/components/product/ReportPreview.tsx");
    const internal = read("src/lib/domain/streaming-aggregator.ts");

    expect(`${report}\n${cleanup}\n${preview}`).not.toMatch(/[">]Ready(?: emails| storage| in selection|<)/);
    expect(`${report}\n${cleanup}\n${preview}`).toMatch(/Suggested/);
    expect(report).toMatch(/Recommendation/);
    expect(internal).toMatch(/Ready and Protected exceed Total/);
  });

  it("uses Trash language for the real cleanup mutation and keeps accounting secondary", () => {
    const cleanup = read("src/components/product/GmailCleanupClient.tsx");

    expect(cleanup).toMatch(/btn btn-primary focus-ring mt-5 w-full[\s\S]+Check \$\{requestedCount\.toLocaleString\(\)\} messages/);
    expect(cleanup).toMatch(/Move \{job\.resolvedCount\.toLocaleString\(\)\} messages to Trash/);
    expect(cleanup).toMatch(/We rechecked these messages and left protected email out/);
    expect(cleanup).toMatch(/Move \{job\.resolvedCount\.toLocaleString\(\)\} to Trash/);
    expect(cleanup).toMatch(/Nothing will be permanently deleted/);
    expect(cleanup).toMatch(/emails moved to Trash/);
    expect(cleanup).toMatch(/still recoverable in Gmail Trash/);
    expect(cleanup).toMatch(/<summary[^>]*>Development cleanup details<\/summary>/);
    expect(cleanup).not.toMatch(/Resolve exact candidates|Trash-only test/);
  });

  it("uses one visible secondary component for named back destinations", () => {
    const component = read("src/components/product/ContextBackAction.tsx");
    const styles = read("app/globals.css");
    const scan = read("app/app/scan/page.tsx");
    const reportState = read("src/lib/server/report-state.ts");
    const cleanup = read("app/app/cleanup/page.tsx");
    const context = read("src/components/product/AppContextActions.tsx");

    expect(component).toMatch(/context-back-action btn btn-secondary focus-ring/);
    expect(component).toMatch(/aria-hidden="true">&larr;/);
    expect(styles).toMatch(/\.btn\s*\{[\s\S]+min-height: 44px/);
    expect(styles).toMatch(/\.btn-secondary:hover\s*\{[\s\S]+background: var\(--soft\)/);
    expect(styles).toMatch(/\.focus-ring:focus-visible/);
    expect(scan).toMatch(/ContextBackAction[^>]+href="\/app"[^>]+label="Back to Organizinbox"/);
    expect(reportState).toMatch(/backHref: "\/app"/);
    expect(cleanup).toMatch(/ContextBackAction[^>]+href="\/app\/report"[^>]+label="Back to Inbox Report"/);
    expect(context).toMatch(/activeReport \? "\/app\/report" : "\/app"/);
    expect(context).toMatch(/activeReport \? "Back to Inbox Report" : "Back to Organizinbox"/);
  });

  it("keeps Outlook availability and privacy claims honest", () => {
    const marketing = read("src/components/product/MarketingInfoContent.tsx");
    const microsoft = read("app/connect/microsoft/page.tsx");
    const dataAccess = read("src/components/product/DataAccessContent.tsx");
    const privacy = read("src/components/product/PrivacyContent.tsx");

    expect(marketing).toMatch(/Outlook support is coming soon/);
    expect(marketing).toMatch(/We&apos;re finishing the Outlook version of Organizinbox/);
    expect(marketing).toMatch(/!appContext \? \([\s\S]+Data access/);
    expect(microsoft).toMatch(/Outlook support is coming soon/);
    expect(dataAccess).toMatch(/Read email bodies", "No"/);
    expect(dataAccess).toMatch(/Process subject lines", "Temporarily"/);
    expect(dataAccess).toMatch(/Subject lines are not stored/);
    expect(dataAccess).toMatch(/Download attachments", "No"/);
    expect(dataAccess).toMatch(/Send email from your mailbox", "No"/);
    expect(dataAccess).toMatch(/Create drafts", "No"/);
    expect(dataAccess).toMatch(/Permanently delete email", "No"/);
    expect(dataAccess).toMatch(/Store a permanent copy of your inbox", "No"/);
    expect(dataAccess).toMatch(/Sell mailbox data", "Never"/);
    expect(dataAccess).toMatch(/Use mailbox data for advertising", "Never"/);
    expect(dataAccess).toMatch(/Train AI on mailbox data", "Never"/);
    expect(privacy).toMatch(/does not sell inbox-derived data/);
    expect(privacy).toMatch(/Subject lines are processed temporarily only to protect messages/);
  });
});
