import React, { type ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the actual client handlers/effects without a DOM or external requests.
const hooks = vi.hoisted(() => ({ active: { slots: [] as unknown[], index: 0, effects: [] as Array<() => void> } }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const scope = hooks.active, index = scope.index++;
    if (!(index in scope.slots)) scope.slots[index] = typeof initial === "function" ? initial() : initial;
    return [scope.slots[index], (next: unknown) => { scope.slots[index] = typeof next === "function" ? next(scope.slots[index]) : next; }];
  },
  useRef(initial: unknown) {
    const scope = hooks.active, index = scope.index++;
    scope.slots[index] ??= { current: initial }; return scope.slots[index];
  },
  useMemo: (compute: () => unknown) => compute(),
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const scope = hooks.active, index = scope.index++;
    const previous = scope.slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    scope.effects.push(() => { previous?.cleanup?.(); scope.slots[index] = { deps, cleanup: effect() }; });
  }
}));
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), poll: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }), usePathname: () => "/app/cleanup" }));
vi.mock("@/components/product/useCleanupAvailability", () => ({ useCleanupAvailability: () => ({ access: "available" }) }));
vi.mock("@/lib/adaptive-polling", () => ({ startAdaptivePolling: mocks.poll }));
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";
import { OperationStatus } from "@/components/product/OperationStatus";
import { AppHeader } from "@/components/product/AppHeader";
import { BillingActions } from "@/components/product/BillingActions";
import type { OutlookCleanupUiJob } from "@/lib/domain/cleanup-ui";
import { getFixtureInboxReport } from "@/lib/fixtures/inbox";
import { buildCleanupSenderGroups } from "@/lib/providers/gmail/cleanup-candidates";

type Scope = typeof hooks.active;
type Element = ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
const scope = (): Scope => ({ slots: [], index: 0, effects: [] });
function render<T>(state: Scope, component: () => T): T {
  hooks.active = state; state.index = 0;
  const result = component();
  state.effects.splice(0).forEach(effect => effect()); return result;
}
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children)];
}
const tree = (element: Element) => (element.type as (props: Element["props"]) => React.ReactNode)(element.props);
const text = (node: React.ReactNode): string => Array.isArray(node) ? node.map(text).join("")
  : React.isValidElement(node) ? text((node as Element).props.children) : String(node ?? "");
let mono = 1000;
const job = (status: OutlookCleanupUiJob["status"], moved = 0): OutlookCleanupUiJob => ({
  provider: "microsoft", id: "job", status, requested: 5, approved: 5, excludedBySafety: 0,
  movedVerified: moved, restoredVerified: 0, failed: 0, uncertain: 0, checked: 5, groupIndices: [],
  undoAvailable: true, undoMode: "full", undoStatus: "available", recoverableCount: moved,
  createdAt: 1000, updatedAt: 2000, expiresAt: Date.now() + 600_000,
  totalBatches: 1, batchesCompleted: 0, undoTotalBatches: 1, undoBatchesCompleted: 0
});
const props = (initialOutlookJob?: OutlookCleanupUiJob) => ({
  groups: buildCleanupSenderGroups(getFixtureInboxReport().senders), bulkUndoProofEnabled: false, cleanupEnabled: true, legacyCleanupMaximum: 0,
  scalableCleanupEnabled: false, fixtureMode: false, provider: "microsoft" as const,
  countOptions: [5], reportStale: false, developmentMode: false, productionAccess: "available" as const, initialOutlookJob
});
function workspace(node: React.ReactNode) { return elements(node).find(e => typeof e.props.onConfirm === "function")!; }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); mono = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => mono);
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("fetch", vi.fn()); mocks.refresh.mockReset(); mocks.poll.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([5, 3])("refreshes the authoritative header once after %i verified moves, not Undo or deletion", async moved => {
  const client = scope();
  const renderClient = () => render(client, () => GmailCleanupClient(props(job("running"))));
  let serverBalance = 60000, displayedBalance = serverBalance;
  // A separate shared-account reservation deliberately makes the partial balance non-arithmetic.
  const resultingBalance = moved === 5 ? 59995 : 59897;
  mocks.refresh.mockImplementation(() => { displayedBalance = serverBalance; });
  const header = () => render(scope(), () => text(AppHeader({
    logoPath: "/logo.png", provider: "microsoft", availableCredits: displayedBalance,
    scanAvailable: true, reportAvailable: true, cleanupAvailable: true
  })));
  renderClient(); expect(header()).toContain("60,000 credits");
  const poll = mocks.poll.mock.calls[0][0] as (signal: AbortSignal) => Promise<boolean>;
  async function update(value: OutlookCleanupUiJob) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: value } }));
    await poll(new AbortController().signal); renderClient();
  }
  await update(job("running", moved)); expect(mocks.refresh).not.toHaveBeenCalled();
  serverBalance = resultingBalance;
  await update(job(moved === 5 ? "complete" : "partial", moved));
  expect(header()).toContain(`${resultingBalance.toLocaleString("en-US")} credits`);
  await update(job("partial", moved));
  await update({ ...job("undo_complete", moved), restoredVerified: moved });
  await update(job("complete", moved)); // Permanent deletion leaves historical move counts unchanged.
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(displayedBalance).toBe(resultingBalance);
  render(scope(), () => GmailCleanupClient(props(job("complete", moved))));
  expect(mocks.refresh).toHaveBeenCalledTimes(1); // Server refresh/remount does not loop.
});

it.each([300_000, -300_000])("uses separate monotonic Check/Move/Undo origins with wall-clock skew %i", async skew => {
  vi.setSystemTime(1_000_000 + skew);
  const client = scope(); let current: React.ReactNode;
  const renderClient = () => current = render(client, () => GmailCleanupClient(props()));
  renderClient();
  const check = elements(current).find(e => e.type === "button" && text(e.props.children) === "Check 5 messages")!;
  expect(check.props.disabled).toBe(false);
  let accept!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  const pending = (check.props.onClick as () => Promise<void>)();
  renderClient();
  const checking = elements(current).find(e => e.props.operation === "resolution")!;
  const pendingTimer = elements(tree(checking)).find(e => e.type === OperationStatus)!;
  expect(pendingTimer.props.monotonicStartedAt).toBe(1000);
  const timer = scope();
  const renderTimer = (element: Element) => render(timer, () => tree(element));
  renderTimer(pendingTimer);
  expect(text(renderTimer(pendingTimer))).toContain("Elapsed: 0s");
  mono = 4000; vi.advanceTimersByTime(3000);
  expect(text(renderTimer(pendingTimer))).toContain("Elapsed: 3s");
  accept(Response.json({ job: { ui: job("ready") } })); await pending; renderClient();

  for (const [handler, status] of [["onConfirm", "running"], ["onUndo", "undoing"]] as const) {
    mono += 10000;
    const origin = mono;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    const request = (workspace(current).props[handler] as () => Promise<void>)();
    renderClient();
    const working = () => elements(tree(workspace(current))).find(e => e.type === OperationStatus)!;
    const first = working(), clock = scope();
    const tick = (element: Element) => render(clock, () => tree(element));
    tick(first); expect(text(tick(first))).toContain("Elapsed: 0s");
    expect(first.props.monotonicStartedAt).toBe(origin);
    mono += 2000; vi.advanceTimersByTime(2000);
    expect(text(tick(first))).toContain("Elapsed: 2s");
    accept(Response.json({ job: { ui: job(status, handler === "onUndo" ? 5 : 0) } })); await request; renderClient();
    expect(working().key).toBe(first.key);
    expect(text(tick(working()))).toContain("Elapsed: 2s");
    const poll = mocks.poll.mock.calls.at(-1)![0] as (signal: AbortSignal) => Promise<boolean>;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: { ...job(status, 5), updatedAt: -99999999 } } }));
    await poll(new AbortController().signal); renderClient();
    mono += 2000; vi.advanceTimersByTime(2000);
    expect(text(tick(working()))).toContain("Elapsed: 4s");
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: job("complete", 5) } }));
    await poll(new AbortController().signal); renderClient();
  }
});

it.each(["resolving", "running", "undoing"] as const)("reattached %s uses a local zero timer, never updatedAt or expiry", status => {
  vi.setSystemTime(1_000_000 + 300000);
  const client = render(scope(), () => GmailCleanupClient(props(job(status))));
  const operation = elements(tree(workspace(client))).find(e => e.type === OperationStatus)!;
  expect(operation.props.startedAt).toBeUndefined();
  expect(operation.props.elapsedMs).toBe(0);
  const timer = scope(); render(timer, () => tree(operation));
  expect(text(render(timer, () => tree(operation)))).toContain("Elapsed: 0s");
  mono += 3000; vi.advanceTimersByTime(3000);
  expect(text(render(timer, () => tree(operation)))).toContain("Elapsed: 3s");
});

it("successful purchase reconciliation retains its explicit server refresh", async () => {
  const billing = render(scope(), () => BillingActions({ canBuy: true, canRefresh: true }));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}));
  const check = elements(billing).find(e => e.type === "button" && text(e.props.children) === "Check payment status")!;
  await (check.props.onClick as () => Promise<void>)();
  expect(fetch).toHaveBeenCalledWith("/api/billing/reconcile", expect.objectContaining({ method: "POST" }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
