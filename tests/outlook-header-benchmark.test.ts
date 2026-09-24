import { describe, expect, it, vi } from "vitest";
import { runOutlookHeaderBenchmark } from "@/lib/server/outlook-header-benchmark";
import { microsoftMessageSelect } from "@/lib/providers/microsoft/provider";
import { scanClockStart } from "@/lib/scan-clock";

describe("Rescan clock", () => {
  it("uses the click time while acceptance is pending even if old completed progress is retained", () => {
    const oldCompleted = { startedAt: 1000, status: "completed" };
    const clickTime = 267000;
    expect(scanClockStart(true, clickTime, oldCompleted.startedAt)).toBe(clickTime);
    expect(scanClockStart(false, clickTime, 268000)).toBe(268000);
    // A real reused=true response switches back to the existing durable origin.
    expect(scanClockStart(false, clickTime, oldCompleted.startedAt)).toBe(oldCompleted.startedAt);
  });
});

describe("bounded Outlook header A/B benchmark", () => {
  it("uses identical selects except headers, trusted pagination, and returns aggregates only", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
      expect(options?.method).toBe("GET");
      const parsed = new URL(String(url));
      const includes = parsed.searchParams.get("$select")?.includes("internetMessageHeaders");
      expect(parsed.pathname).toBe("/v1.0/me/messages");
      expect(parsed.searchParams.get("$top")).toBe("100");
      expect(parsed.searchParams.get("$select")?.split(",")).toEqual(microsoftMessageSelect.filter((field) => includes || field !== "internetMessageHeaders"));
      const value = [{ id: "PRIVATE-ID", subject: "PRIVATE-SUBJECT", ...(includes ? { internetMessageHeaders: [{ name: "Private", value: "PRIVATE-HEADER" }] } : {}) }];
      return Response.json({ value, "@odata.nextLink": String(url) });
    });
    const result = await runOutlookHeaderBenchmark({ accessToken: "PRIVATE-TOKEN", signal: new AbortController().signal,
      noHeadersFirst: false, coordinate: (request) => request(), fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(result.results.map((arm) => [arm.includeHeaders, arm.pages, arm.messages, arm.success])).toEqual([[true, 5, 5, true], [false, 5, 5, true]]);
    expect(result.results[0].decodedBytes).toBeGreaterThan(result.results[1].decodedBytes);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https:|nextLink|subject|sender|accessToken/);
  });

  it("separates body read, UTF-8 size and parsing timings without altering normal clients", async () => {
    let clock = 0;
    const timer = vi.spyOn(performance, "now").mockImplementation(() => clock++);
    const text = JSON.stringify({ value: [{ subject: "é" }] });
    const fetchImpl = vi.fn(async () => {
      const response = new Response(text);
      response.text = async () => { clock += 100; return text; };
      return response;
    });
    try {
      const result = await runOutlookHeaderBenchmark({ accessToken: "fixture", signal: new AbortController().signal,
        noHeadersFirst: true, coordinate: (request) => request(), fetchImpl });
      expect(result.results[0].includeHeaders).toBe(false);
      for (const arm of result.results) {
        expect(arm.bodyReadMs).toBeGreaterThanOrEqual(100);
        expect(arm.jsonParseMs).toBe(1);
        expect(arm.decodedBytes).toBe(Buffer.byteLength(text));
        expect(arm.decodedCharacters).toBe(text.length);
      }
    } finally { timer.mockRestore(); }
  });

  it("stops on lost authorization and returns no raw exception", async () => {
    const fetchImpl = vi.fn();
    const result = await runOutlookHeaderBenchmark({ accessToken: "fixture", signal: new AbortController().signal,
      noHeadersFirst: false, coordinate: async () => { throw new DOMException("PRIVATE", "AbortError"); }, fetchImpl });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
