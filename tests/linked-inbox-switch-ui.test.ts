import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinkedInboxList } from "@/components/product/LinkedInboxList";
import type { LinkedInbox } from "@/lib/domain/linked-inboxes";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    return hooks.values[index] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  }
}));
const inboxes: LinkedInbox[] = [{ id: "target", provider: "gmail", email: "target@example.test", active: false, state: "ready" }];
const navigate = vi.fn();
const close = vi.fn();
const fetchMock = vi.fn();
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; vi.clearAllMocks();
  vi.stubGlobal("window", { location: { assign: navigate } }); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
function render() { hooks.cursor = 0; return LinkedInboxList({ inboxes, onSwitch: close }); }
function button(node: ReactNode): ReactElement<{ onClick: () => Promise<void> }> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === "button") return child as ReactElement<{ onClick: () => Promise<void> }>;
    const found = button(child.props.children); if (found) return found;
  }
}
it("guards duplicate clicks, shows progress, closes the menu and performs a fresh navigation only after acceptance", async () => {
  let resolve!: (value: Response) => void;
  fetchMock.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
  const action = button(render())!.props.onClick;
  const pending = action();
  await action();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/app/inbox/switch", expect.objectContaining({ method: "POST", body: '{"connectionId":"target"}' }));
  expect(renderToStaticMarkup(render())).toContain("Switching...");
  expect(navigate).not.toHaveBeenCalled();
  resolve(Response.json({ url: "/app/report" })); await pending;
  expect(close).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledWith("/app/report");
});
it("keeps the current page and exposes a reconnect action on rejected saved credentials", async () => {
  fetchMock.mockResolvedValue(Response.json({ code: "needs_reconnect", error: "This inbox needs to reconnect." }, { status: 409 }));
  await button(render())!.props.onClick();
  const html = renderToStaticMarkup(render());
  expect(html).toContain("Needs reconnect"); expect(html).toContain("Reconnect Gmail");
  expect(html).toContain('role="alert"'); expect(html).not.toContain("Switch inbox");
  expect(navigate).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});
it("rejects unexpected destinations rather than navigating to OAuth or an external URL", async () => {
  fetchMock.mockResolvedValue(Response.json({ url: "https://example.test/oauth" }));
  await button(render())!.props.onClick();
  expect(navigate).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(renderToStaticMarkup(render())).toContain("Try again");
});
