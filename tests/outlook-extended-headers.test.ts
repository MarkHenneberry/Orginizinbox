import { describe, expect, it, vi } from "vitest";
import { runOutlookExtendedHeaderBenchmark } from "@/lib/server/outlook-extended-header-benchmark";
import { advanceScanElapsed } from "@/lib/scan-clock";
import { createProgress, serializeScanProgress } from "@/lib/server/live-scan-store";

it("uses server durations and monotonic browser time despite five-minute wall-clock skew", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000000);
  try {
    const progress = createProgress({ provider: "microsoft", scanId: "fixture", limit: "full", batchSize: 100 });
    clock.mockReturnValue(1000200);
    const fresh = serializeScanProgress(progress).elapsedMs;
    clock.mockReturnValue(1300200); // Browser is five minutes ahead.
    expect(advanceScanElapsed(fresh, 50, 1050)).toBe(1200);
    clock.mockReturnValue(700200); // Or five minutes behind.
    expect(advanceScanElapsed(fresh, 50, 1050)).toBe(1200);
    expect(advanceScanElapsed(267000, 50, 2050)).toBe(269000); // Reattached duration.
  } finally { clock.mockRestore(); }
});

describe("extended-header probe", () => {
  it.each([false, true])("compares exact identities and tests single-property fallback, OR rejected=%s", async (rejectOr) => {
    const names = ["List-Id", "List-Unsubscribe", "Precedence", "Auto-Submitted"];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
      expect(options?.method).toBe("GET");
      const expand = new URL(String(url)).searchParams.get("$expand");
      if (rejectOr && expand?.includes(" or ")) return new Response(null, { status: 400 });
      return Response.json({ value: [{ id: "PRIVATE-ID",
        ...(expand ? { singleValueExtendedProperties: names.filter((name) => expand.includes(`Name ${name}'`)).map((name) => ({
          id: `String {00020386-0000-0000-C000-000000000046} Name ${name}`, value: "PRIVATE-VALUE"
        })) } : { internetMessageHeaders: names.map((name) => ({ name, value: "PRIVATE-VALUE" })) })
      }] });
    });
    const result = await runOutlookExtendedHeaderBenchmark({ accessToken: "PRIVATE-TOKEN", signal: new AbortController().signal,
      coordinate: (request) => request(), fetchImpl: fetchImpl as typeof fetch });
    expect(result.singlePropertyCollections?.parity.exact).toBe(true);
    expect(result.combined?.parity.exact).toBe(!rejectOr);
    expect(result.combined?.unsupported).toBe(rejectOr);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https:|nextLink|subject|sender/);
  });
  it("does not report parity when targeted collection contains different messages", async () => {
    let calls = 0;
    const result = await runOutlookExtendedHeaderBenchmark({ accessToken: "fixture", signal: new AbortController().signal,
      coordinate: (request) => request(), fetchImpl: vi.fn(async () => Response.json({ value: [{ id: calls++ ? "other" : "original" }] })) });
    expect(result.combined?.parity.exact).toBe(false);
    expect(result.singlePropertyCollections?.parity.missingMessages).toBe(1);
  });
});
