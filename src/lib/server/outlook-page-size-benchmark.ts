import "server-only";
import { MicrosoftGraphClient } from "@/lib/providers/microsoft/graph-client";
import { microsoftMessageSelect } from "@/lib/providers/microsoft/provider";

// Temporary measurement only. Identities never leave this function or reach report storage.
export async function runOutlookPageSizeBenchmark(input: {
  accessToken: string;
  signal: AbortSignal;
  reverse?: boolean;
  coordinate: <T>(request: () => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
}) {
  const arms = [];
  let stop = false;
  for (const requestedPageSize of input.reverse ? [500, 250, 100] : [100, 250, 500]) {
    const ids = new Set<string>();
    const result = {
      requestedPageSize, messagesRetrieved: 0, sampledMessages: 0, pages: 0,
      requests: 0, retries: 0, throttles429: 0, failures5xx: 0, failures504: 0,
      decodedBytes: 0, bodyReadMs: 0, jsonParseMs: 0, responseBodyJsonMs: 0,
      fetchMs: 0, durationMs: 0, messagesPerSecond: 0, duplicateCount: 0,
      success: false, failure: "not_run" as string | null,
      overlapCount: null as number | null, missingCount: null as number | null,
      sameSample: false
    };
    arms.push({ result, ids });
    if (stop || input.signal.aborted) continue;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(80_000)]);
    let lastStatus = 0;
    const started = performance.now();
    const client = new MicrosoftGraphClient({
      accessToken: input.accessToken, maxRetries: 0,
      requestCoordinator: (request) => input.coordinate(() => {
        signal.throwIfAborted();
        return request();
      }),
      fetchImpl: async (url, options) => {
        const fetchStarted = performance.now();
        let response: Response;
        try { response = await (input.fetchImpl ?? fetch)(url, options); }
        finally { result.fetchMs += performance.now() - fetchStarted; }
        lastStatus = response.status;
        if (response.status === 504) result.failures504++;
        if (!response.ok) {
          // Do not download or log provider error bodies.
          await response.body?.cancel();
          return response;
        }
        response.json = async () => {
          const readStarted = performance.now();
          let text: string;
          try { text = await response.text(); }
          finally { result.bodyReadMs += performance.now() - readStarted; }
          result.decodedBytes += Buffer.byteLength(text, "utf8");
          const parseStarted = performance.now();
          try { return JSON.parse(text) as unknown; }
          finally { result.jsonParseMs += performance.now() - parseStarted; }
        };
        return response;
      }
    });
    let next: string | undefined = `/me/messages?${new URLSearchParams({
      "$select": microsoftMessageSelect.join(","), "$top": String(requestedPageSize)
    })}`;
    try {
      while (next && result.sampledMessages < 1000 && result.pages < 20) {
        signal.throwIfAborted();
        const page: { value?: unknown; "@odata.nextLink"?: unknown } = await client.getJson(next, signal, "main_message_scan");
        if (!page || !Array.isArray(page.value) || page.value.length > requestedPageSize ||
          (page["@odata.nextLink"] !== undefined &&
            (typeof page["@odata.nextLink"] !== "string" || !page["@odata.nextLink"]))) {
          result.failure = "invalid_response";
          throw new Error("Invalid benchmark page");
        }
        for (const message of page.value) {
          if (!message || typeof message.id !== "string" || !message.id) {
            result.failure = "invalid_response";
            throw new Error("Invalid benchmark identity");
          }
        }
        result.pages++;
        result.messagesRetrieved += page.value.length;
        for (const message of page.value.slice(0, 1000 - result.sampledMessages)) {
          result.sampledMessages++;
          if (ids.has(message.id)) result.duplicateCount++;
          ids.add(message.id);
        }
        next = page["@odata.nextLink"] as string | undefined;
      }
      result.success = !next || result.sampledMessages === 1000;
      result.failure = result.success ? null : "page_limit";
    } catch {
      if (input.signal.aborted) result.failure = "cancelled";
      else if (signal.aborted) result.failure = "timeout";
      else if (lastStatus >= 400) result.failure = "http_error";
      else if (result.failure !== "invalid_response") result.failure = "request_or_response_failed";
      // Unknown failures include durable authorization loss; never proceed on a new arm.
      stop = input.signal.aborted || (!signal.aborted && lastStatus < 400) ||
        lastStatus === 401 || lastStatus === 403 || lastStatus === 429;
    }
    const metrics = client.getMetrics();
    result.requests = metrics.requests;
    result.retries = metrics.retries;
    result.throttles429 = metrics.throttles429;
    result.failures5xx = metrics.failures5xx;
    result.durationMs = Math.round(performance.now() - started);
    result.messagesPerSecond = result.durationMs ? Math.round(result.messagesRetrieved * 100_000 / result.durationMs) / 100 : 0;
    result.fetchMs = Math.round(result.fetchMs);
    result.bodyReadMs = Math.round(result.bodyReadMs);
    result.jsonParseMs = Math.round(result.jsonParseMs);
    result.responseBodyJsonMs = result.bodyReadMs + result.jsonParseMs;
  }
  const baseline = arms.find((arm) => arm.result.requestedPageSize === 100)!;
  for (const arm of arms) {
    if (!baseline.result.success) continue;
    arm.result.overlapCount = [...arm.ids].filter((id) => baseline.ids.has(id)).length;
    arm.result.missingCount = baseline.ids.size - arm.result.overlapCount;
    arm.result.sameSample = arm.result.success && !arm.result.duplicateCount && !baseline.result.duplicateCount &&
      arm.result.missingCount === 0 && arm.ids.size === baseline.ids.size;
  }
  return { sampled: true, sampleTarget: 1000, baselinePageSize: 100, armTimeoutMs: 80_000,
    results: arms.map((arm) => arm.result) };
}
