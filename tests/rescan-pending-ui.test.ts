import React, { type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

// Small hook harness exercises the real event handler across pending/accepted renders.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useMemo: (compute: () => unknown) => compute(),
  useEffect: () => undefined
}));
import { OutlookScanClient } from "@/components/product/GmailScanClient";
import { OperationStatus } from "@/components/product/OperationStatus";

type Element = ReactElement<{ children?: React.ReactNode; onClick?: () => Promise<void>; startedAt?: number; elapsedMs?: number }>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("completed scan -> click Rescan -> fresh pending timer -> accepted reuse=%s", async (reused) => {
  hooks.values = [];
  vi.spyOn(Date, "now").mockReturnValue(267000);
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  const component = OutlookScanClient({ imapAvailable: false, imapBenchmarkEnabled: false,
    initialProgress: { scanId: "old", provider: "microsoft", status: "completed", processed: 10000, startedAt: 1000, errors: [] }
  });
  const render = () => {
    hooks.index = 0;
    return (component.type as (props: typeof component.props) => React.ReactNode)(component.props);
  };
  const button = elements(render()).find((element) => element.type === "button" && element.props.children === "Rescan inbox")!;
  const pending = button.props.onClick!();
  const pendingStatus = elements(render()).find((element) => element.type === OperationStatus)!;
  expect(pendingStatus.props.startedAt).toBe(267000);
  expect(pendingStatus.props.elapsedMs).toBe(0);
  expect(pendingStatus.key).toBe("267000");
  resolve(Response.json({ reused, progress: { scanId: reused ? "existing" : "fresh", provider: "microsoft",
    status: "running", startedAt: reused ? 1000 : 268000, elapsedMs: reused ? 267000 : 200, processed: 0, errors: [] } }));
  await pending;
  const accepted = elements(render());
  expect(accepted.find((element) => element.type === OperationStatus)!.props.startedAt).toBe(reused ? 1000 : 268000);
  expect(accepted.find((element) => element.type === OperationStatus)!.props.elapsedMs).toBe(reused ? 267000 : 200);
  expect(accepted.some((element) => element.props.children === "Continuing your existing scan. Elapsed time includes work already in progress.")).toBe(reused);
});
