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
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), poll: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace, push: vi.fn() }), usePathname: () => "/app/cleanup" }));
vi.mock("@/components/product/useCleanupAvailability", () => ({ useCleanupAvailability: () => ({ access: "available" }) }));
vi.mock("@/lib/adaptive-polling", () => ({ startAdaptivePolling: mocks.poll }));
import { GmailCleanupClient } from "@/components/product/GmailCleanupClient";
import { OperationStatus } from "@/components/product/OperationStatus";
import { CleanupAccessNotice } from "@/components/product/CleanupAccessNotice";
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
  vi.stubGlobal("fetch", vi.fn()); mocks.refresh.mockReset(); mocks.replace.mockReset(); mocks.poll.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("posts one correlated ready-render sample after a fresh Outlook check without router transitions or extra polling", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const client = scope(); let current: React.ReactNode;
  const renderClient = () => current = render(client, () => GmailCleanupClient(props()));
  renderClient();
  const sender = elements(current).find(e => e.type === "input" && e.props.type === "checkbox" && !e.props.disabled)!;
  (sender.props.onChange as () => void)(); renderClient();
  const check = elements(current).find(e => e.type === "button" && text(e.props.children).startsWith("Check "))!;
  const correlationId = "11111111-1111-4111-8111-111111111111";
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: job("resolving") } }, { headers: { "X-Outlook-Verification-Id": correlationId } }));
  await (check.props.onClick as () => Promise<void>)(); renderClient();
  const poll = mocks.poll.mock.calls.at(-1)![0] as (signal: AbortSignal) => Promise<boolean>;
  mono += 60_000;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: job("ready") } }, { headers: { "X-Outlook-Ready-Checkpoint-Age-Ms": "1000" } }));
  expect(await poll(new AbortController().signal)).toBe(false); renderClient();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
  await vi.advanceTimersByTimeAsync(33);
  renderClient(); await vi.advanceTimersByTimeAsync(100);
  const samples = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/app/cleanup/verification-timing");
  expect(samples).toHaveLength(1);
  expect(JSON.parse(samples[0][1]!.body as string)).toMatchObject({ correlationId, clientTotalMs: 60_000, pollRequests: 1 });
  expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
});

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
  const sender = elements(current).find(e => e.type === "input" && e.props.type === "checkbox" && !e.props.disabled)!;
  (sender.props.onChange as () => void)(); renderClient();
  const check = elements(current).find(e => e.type === "button" && text(e.props.children).startsWith("Check "))!;
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

it.each(["ready", "resolving"] as const)("Change selection returns %s jobs directly to zero selection only after authoritative discard", async status => {
  const group = props().groups.find(group => group.eligible)!;
  const initial = { ...job(status), canChangeSelection: true, groupIndices: [group.index], senderGroups: [group] };
  const client = scope(); let current: React.ReactNode;
  const renderClient = () => current = render(client, () => GmailCleanupClient(props(initial)));
  renderClient();
  const poll = mocks.poll.mock.calls[0]?.[0] as ((signal: AbortSignal) => Promise<boolean>) | undefined;
  const change = elements(tree(workspace(current))).find(e => e.type === "button" && text(e.props.children) === "Change selection")!;
  let accept!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  const pending = (change.props.onClick as () => Promise<void>)(); renderClient();
  expect(workspace(current)).toBeDefined();
  expect(workspace(current).props.job).toBe(initial);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith("/api/app/cleanup/microsoft/discard", expect.objectContaining({ method: "POST", body: JSON.stringify({ jobId: "job", confirmed: true }) }));
  accept(Response.json({ discarded: true })); await pending; renderClient();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(workspace(current)).toBeUndefined();
  expect(elements(current).some(e => e.type === CleanupAccessNotice && e.props.access !== "available")).toBe(false);
  expect(text(current)).toContain("Select one or more sender groups to check");
  expect(text(current)).toContain(group.displayName);
  expect(elements(current).filter(e => e.type === "input" && e.props.type === "checkbox" && e.props.checked)).toHaveLength(0);
  expect(elements(current).find(e => e.type === "button" && text(e.props.children) === "Check selection")?.props.disabled).toBe(true);
  if (poll) {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: job("ready") } }));
    expect(await poll(new AbortController().signal)).toBe(false); renderClient();
    expect(workspace(current)).toBeUndefined();
  }
});

it.each([409, 200])("failed discard (%i) keeps the ready job and shows an error without navigation", async status => {
  const initial = { ...job("ready"), canChangeSelection: true };
  const client = scope();
  const renderClient = () => render(client, () => GmailCleanupClient(props(initial)));
  const current = renderClient();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ discarded: false, error: "Selection could not be changed." }, { status }));
  await (workspace(current).props.onChangeSelection as () => Promise<void>)();
  const updated = renderClient();
  expect(workspace(updated).props.job).toBe(initial);
  expect(workspace(updated).props.error).toBe("Selection could not be changed.");
  expect(text(updated)).not.toContain("Select one or more sender groups to check");
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it.each(["running", "complete", "partial", "uncertain", "undoing", "undo_complete"] as const)("%s recovery/mutation jobs cannot Change selection", async status => {
  const initial = { ...job(status, 3), canChangeSelection: false };
  const client = scope();
  const renderClient = () => render(client, () => GmailCleanupClient(props(initial)));
  const current = renderClient();
  expect(text(tree(workspace(current)))).not.toContain("Change selection");
  await (workspace(current).props.onChangeSelection as () => Promise<void>)();
  expect(fetch).not.toHaveBeenCalled();
  expect(workspace(renderClient()).props.job).toBe(initial);
});

it("successful purchase reconciliation retains its explicit server refresh", async () => {
  const billing = render(scope(), () => BillingActions({ canBuy: true, canRefresh: true }));
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}));
  const check = elements(billing).find(e => e.type === "button" && text(e.props.children) === "Check payment status")!;
  await (check.props.onClick as () => Promise<void>)();
  expect(fetch).toHaveBeenCalledWith("/api/billing/reconcile", expect.objectContaining({ method: "POST" }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("recomputes Outlook relative amounts from selected Potential cleanup only and posts All recommended as an exact count", async () => {
  const base = props().groups.find(group => group.eligible)!;
  const groups = [
    { ...base, index: 0, displayName: "First sender", cleanupCandidateCount: 1379, reviewMessages: 400, protectedMessages: 200 },
    { ...base, index: 1, displayName: "Second sender", cleanupCandidateCount: 8621, reviewMessages: 600, protectedMessages: 300 }
  ];
  const client = scope(); let current: React.ReactNode;
  const renderClient = () => current = render(client, () => GmailCleanupClient({ ...props(), groups }));
  const chooseGroup = (index: number) => {
    const box = elements(current).find(e => e.type === "input" && e.props["aria-label"] === `Select ${groups[index].displayName}`)!;
    (box.props.onChange as () => void)(); renderClient();
  };
  const select = () => elements(current).find(e => e.type === "select" && e.props.id === "cleanup-count")!;
  const check = () => elements(current).find(e => e.type === "button" && text(e.props.children).startsWith("Check "))!;
  renderClient(); expect(select().props.disabled).toBe(true); expect(mocks.poll).not.toHaveBeenCalled();
  chooseGroup(0);
  expect(text(select())).toContain("All recommended (1,379)");
  expect(text(select())).toContain("350 messages (~25%)");
  expect(text(check())).toBe("Check 1,379 messages");
  (select().props.onChange as (event: unknown) => void)({ target: { value: "25" } }); renderClient();
  expect(text(check())).toBe("Check 350 messages");
  chooseGroup(1);
  expect(text(select())).toContain("All recommended (10,000)");
  expect(text(check())).toBe("Check 2,500 messages");
  (select().props.onChange as (event: unknown) => void)({ target: { value: "100" } }); renderClient();
  expect(text(check())).toBe("Check 10,000 messages");
  expect(mocks.poll).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: { ...job("resolving"), requested: 10000, approved: 3400,
    verification: { candidatesTotal: 10000, candidatesChecked: 3400, approved: 3400, excluded: 0 } } } }));
  await (check().props.onClick as () => Promise<void>)(); renderClient();
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ groupIndices: [0, 1], requestedCount: 10000 });
  expect(text(tree(workspace(current)))).toContain("3,400 of 10,000 candidates checked (34%)");
  const progress = elements(tree(workspace(current))).find(e => e.type === "progress")!;
  expect(progress.props).toMatchObject({ max: 10000, value: 3400 });
  const poll = mocks.poll.mock.calls.at(-1)![0] as (signal: AbortSignal) => Promise<boolean>;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: { ...job("ready"), requested: 10000, approved: 10000 } } }));
  expect(await poll(new AbortController().signal)).toBe(false); renderClient();
  const polls = mocks.poll.mock.calls.length;
  renderClient(); expect(mocks.poll).toHaveBeenCalledTimes(polls);
});

it.each([
  { status: 400, code: "INVALID_CLEANUP_COUNT", expected: "Choose an amount from the list" },
  { status: 400, code: undefined, expected: "Cleanup could not continue" },
  { status: 503, code: undefined, expected: "Cleanup could not continue" }
])("keeps a rejected Outlook check visible and retryable without a phantom job ($status/$code)", async ({ status, code, expected }) => {
  const base = props().groups.find(group => group.eligible)!;
  const groups = [{ ...base, index: 0, cleanupCandidateCount: 1096 }];
  const client = scope(); let current: React.ReactNode;
  const renderClient = () => current = render(client, () => GmailCleanupClient({ ...props(), groups }));
  renderClient();
  const box = elements(current).find(e => e.type === "input" && e.props.type === "checkbox" && !e.props.disabled)!;
  (box.props.onChange as () => void)(); renderClient();
  const select = elements(current).find(e => e.type === "select" && e.props.id === "cleanup-count")!;
  (select.props.onChange as (event: unknown) => void)({ target: { value: "50" } }); renderClient();
  const check = () => elements(current).find(e => e.type === "button" && text(e.props.children).startsWith("Check "))!;
  expect(text(check())).toBe("Check 550 messages");
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code, error: "private raw provider/database response" }, { status }));
  await (check().props.onClick as () => Promise<void>)(); renderClient();
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).requestedCount).toBe(550);
  const alert = elements(current).find(e => e.props.role === "alert")!;
  expect(text(tree(alert))).toContain(expected);
  expect(text(tree(alert))).not.toContain("private raw");
  expect(check().props.disabled).toBe(false);
  expect(workspace(current)).toBeUndefined();
  expect(mocks.poll).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.replace).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ job: { ui: { ...job("resolving"), requested: 550 } } }));
  await (check().props.onClick as () => Promise<void>)(); renderClient();
  expect(workspace(current).props.job).toMatchObject({ requested: 550, status: "resolving" });
  expect(mocks.poll).toHaveBeenCalledOnce();
});
