import "server-only";
import { MicrosoftGraphClient } from "@/lib/providers/microsoft/graph-client";
import { microsoftMessageSelect } from "@/lib/providers/microsoft/provider";

// Temporary bounded experiment: never classify, aggregate a report, or persist a response.
export async function runOutlookHeaderBenchmark(input: {
  accessToken: string;
  signal: AbortSignal;
  noHeadersFirst: boolean;
  coordinate: <T>(request: () => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
}) {
  const results = [];
  for (const includeHeaders of input.noHeadersFirst ? [false, true] : [true, false]) {
    const result = { includeHeaders, pages: 0, messages: 0, requests: 0, retries: 0,
      fetchMs: 0, bodyReadMs: 0, jsonParseMs: 0, decodedBytes: 0, decodedCharacters: 0,
      durationMs: 0, mailboxComplete: false, success: false };
    const started = performance.now();
    const fetchImpl: typeof fetch = async (url, options) => {
      const fetchStarted = performance.now();
      const response = await (input.fetchImpl ?? fetch)(url, options);
      result.fetchMs += performance.now() - fetchStarted;
      // Only this benchmark opts into text + explicit parse; the normal scanner is unchanged.
      response.json = async () => {
        const bodyStarted = performance.now();
        let text: string;
        try { text = await response.text(); }
        finally { result.bodyReadMs += performance.now() - bodyStarted; }
        result.decodedCharacters += text.length;
        result.decodedBytes += Buffer.byteLength(text, "utf8");
        const parseStarted = performance.now();
        try { return JSON.parse(text) as unknown; }
        finally { result.jsonParseMs += performance.now() - parseStarted; }
      };
      return response;
    };
    const client = new MicrosoftGraphClient({ accessToken: input.accessToken, fetchImpl,
      requestCoordinator: input.coordinate });
    const select = microsoftMessageSelect.filter((field) => includeHeaders || field !== "internetMessageHeaders");
    let next: string | undefined = `/me/messages?${new URLSearchParams({ "$select": select.join(","), "$top": "100" })}`;
    try {
      for (let page = 0; next && page < 5; page++) {
        const value: { value?: unknown; "@odata.nextLink"?: unknown } = await client.getJson(next, input.signal, "main_message_scan");
        if (!value || !Array.isArray(value.value) ||
          (value["@odata.nextLink"] !== undefined && typeof value["@odata.nextLink"] !== "string")) throw new Error("Invalid benchmark page");
        result.pages++;
        result.messages += value.value.length;
        next = value["@odata.nextLink"] as string | undefined;
      }
      result.mailboxComplete = !next;
      result.success = true;
    } catch { /* Aggregate failure only. Never expose exception or provider data. */ }
    result.requests = client.getMetrics().requests;
    result.retries = client.getMetrics().retries;
    result.durationMs = Math.round(performance.now() - started);
    result.fetchMs = Math.round(result.fetchMs);
    result.bodyReadMs = Math.round(result.bodyReadMs);
    result.jsonParseMs = Math.round(result.jsonParseMs);
    results.push(result);
    if (!result.success) break;
  }
  return { sampled: true, pageSize: 100, pageLimitPerArm: 5, results };
}
