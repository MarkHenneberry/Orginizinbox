import { expect, it, vi } from "vitest";
import { runOutlookPageSizeBenchmark } from "@/lib/server/outlook-page-size-benchmark";
import { microsoftMessageSelect } from "@/lib/providers/microsoft/provider";

const input = () => ({ accessToken: "PRIVATE-TOKEN", signal: new AbortController().signal,
  coordinate: <T>(request: () => Promise<T>) => request() });

function pageFetch(alter?: (top: number, offset: number) => Response | undefined) {
  return vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
    const parsed = new URL(String(url));
    const top = Number(parsed.searchParams.get("$top"));
    const offset = Number(parsed.searchParams.get("$skip") ?? 0);
    expect(parsed.pathname).toBe("/v1.0/me/messages");
    expect(parsed.searchParams.get("$select")).toBe(microsoftMessageSelect.join(","));
    expect(parsed.searchParams.get("$select")).toContain("internetMessageHeaders");
    expect(options?.method).toBe("GET");
    const override = alter?.(top, offset);
    if (override) return override;
    parsed.searchParams.set("$skip", String(offset + top));
    return Response.json({ value: Array.from({ length: top }, (_, i) => ({
      id: `PRIVATE-ID-${offset + i}`, subject: "PRIVATE-SUBJECT",
      internetMessageHeaders: [{ name: "List-Id", value: "PRIVATE-HEADER" }]
    })), "@odata.nextLink": parsed.toString() });
  });
}

it.each([false, true])("bounds full-header arms and correlates only transient identities, reversed=%s", async (reverse) => {
  const fetchImpl = pageFetch();
  const result = await runOutlookPageSizeBenchmark({ ...input(), reverse, fetchImpl });
  expect(result.results.map((arm) => arm.requestedPageSize)).toEqual(reverse ? [500, 250, 100] : [100, 250, 500]);
  for (const arm of result.results) {
    expect(arm).toMatchObject({ messagesRetrieved: 1000, sampledMessages: 1000,
      pages: 1000 / arm.requestedPageSize, requests: 1000 / arm.requestedPageSize,
      retries: 0, overlapCount: 1000, missingCount: 0, duplicateCount: 0, sameSample: true, success: true });
    expect(arm.decodedBytes).toBeGreaterThan(0);
    expect(arm.responseBodyJsonMs).toBeGreaterThanOrEqual(0);
  }
  expect(fetchImpl).toHaveBeenCalledTimes(16);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|nextLink|https:|subject|sender/);
});

it("reports missing and duplicate identities instead of asserting an identical sample", async () => {
  const result = await runOutlookPageSizeBenchmark({ ...input(), fetchImpl: pageFetch((top) => top === 250
    ? Response.json({ value: [{ id: "PRIVATE-ID-0" }, { id: "PRIVATE-ID-0" }, { id: "different" }] }) : undefined) });
  expect(result.results[1]).toMatchObject({ overlapCount: 1, missingCount: 999, duplicateCount: 1, sameSample: false });
});

it.each([429, 500, 504])("records HTTP %s without retry or raw error content", async (status) => {
  const fetchImpl = pageFetch((top) => top === 500 ? new Response("PRIVATE-ERROR", { status }) : undefined);
  const result = await runOutlookPageSizeBenchmark({ ...input(), fetchImpl });
  expect(result.results[2]).toMatchObject({ success: false, failure: "http_error", requests: 1, retries: 0,
    throttles429: status === 429 ? 1 : 0, failures5xx: status >= 500 ? 1 : 0, failures504: status === 504 ? 1 : 0 });
  expect(fetchImpl).toHaveBeenCalledTimes(15);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("stops later arms on throttling, authorization loss or cancellation", async () => {
  for (const status of [401, 403, 429]) {
    const fetchImpl = pageFetch(() => new Response(null, { status }));
    const result = await runOutlookPageSizeBenchmark({ ...input(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.results[1].failure).toBe("not_run");
  }
  const fetchImpl = pageFetch();
  const result = await runOutlookPageSizeBenchmark({ ...input(), fetchImpl,
    coordinate: async () => { throw new Error("PRIVATE-AUTHORIZATION"); } });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(result.results[1].failure).toBe("not_run");
  const cancelled = await runOutlookPageSizeBenchmark({ ...input(), fetchImpl, signal: AbortSignal.abort() });
  expect(cancelled.results.every((arm) => arm.failure === "not_run")).toBe(true);
});

it("records an arm timeout without retrying the timed-out request", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("Timeout", "TimeoutError")));
  try {
    const fetchImpl = pageFetch();
    const result = await runOutlookPageSizeBenchmark({ ...input(), fetchImpl });
    expect(result.results.every((arm) => arm.failure === "timeout" && arm.retries === 0)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally { timeout.mockRestore(); }
});

it("fails closed for malformed pages and untrusted next links", async () => {
  for (const page of [{ value: [{ subject: "PRIVATE" }] }, { value: [], "@odata.nextLink": "https://evil.test/PRIVATE" }]) {
    const fetchImpl = vi.fn(async () => Response.json(page));
    const result = await runOutlookPageSizeBenchmark({ ...input(), fetchImpl });
    expect(result.results[0].success).toBe(false);
    expect(result.results[1].failure).toBe("not_run");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  }
});
