import "server-only";
import { MicrosoftGraphClient } from "@/lib/providers/microsoft/graph-client";
import { allowlistedHeaders, microsoftMessageSelect } from "@/lib/providers/microsoft/provider";

const names = ["List-Id", "List-Unsubscribe", "Precedence", "Auto-Submitted"] as const;
const propertyId = (name: string) => `String {00020386-0000-0000-C000-000000000046} Name ${name}`;
type Message = { id: string; internetMessageHeaders?: unknown; singleValueExtendedProperties?: { id: string; value: string }[] };
const metrics = () => ({ messages: 0, requests: 0, retries: 0, decodedBytes: 0, bodyReadMs: 0, jsonParseMs: 0, durationMs: 0, success: false });

// Temporary bounded collection probe. Identity/value maps never leave this invocation.
export async function runOutlookExtendedHeaderBenchmark(input: {
  accessToken: string; signal: AbortSignal;
  coordinate: <T>(request: () => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
}) {
  async function collect(headers: boolean, properties: readonly string[]) {
    const totals = metrics();
    const started = performance.now();
    const fetchImpl: typeof fetch = async (url, options) => {
      const response = await (input.fetchImpl ?? fetch)(url, options);
      response.json = async () => {
        const start = performance.now();
        let text: string;
        try { text = await response.text(); } finally { totals.bodyReadMs += performance.now() - start; }
        totals.decodedBytes += Buffer.byteLength(text, "utf8");
        const parse = performance.now();
        try { return JSON.parse(text) as unknown; } finally { totals.jsonParseMs += performance.now() - parse; }
      };
      return response;
    };
    const client = new MicrosoftGraphClient({ accessToken: input.accessToken, fetchImpl, requestCoordinator: input.coordinate });
    const rows = new Map<string, Map<string, string>>();
    let unsupported = false;
    try {
      const query = new URLSearchParams({ "$top": "100", "$select": microsoftMessageSelect.filter((field) => headers || field !== "internetMessageHeaders").join(",") });
      if (!headers) query.set("$expand", `singleValueExtendedProperties($filter=${properties.map((name) => `id eq '${propertyId(name)}'`).join(" or ")})`);
      const page = await client.getJson<{ value: Message[] }>(`/me/messages?${query}`, input.signal, "main_message_scan");
      if (!Array.isArray(page.value)) throw new Error("Invalid page");
      for (const message of page.value) {
        if (typeof message.id !== "string" || rows.has(message.id)) throw new Error("Ambiguous sample");
        const values = headers ? allowlistedHeaders(message.internetMessageHeaders) : new Map<string, string>();
        if (!headers && message.singleValueExtendedProperties !== undefined) {
          if (!Array.isArray(message.singleValueExtendedProperties)) throw new Error("Invalid properties");
          for (const property of message.singleValueExtendedProperties) {
            if (typeof property.id !== "string" || typeof property.value !== "string") throw new Error("Invalid property");
            const name = names.find((name) => propertyId(name).toLowerCase() === property.id.toLowerCase());
            if (name) {
              if (values.has(name.toLowerCase())) throw new Error("Duplicate property");
              values.set(name.toLowerCase(), property.value);
            }
          }
        }
        rows.set(message.id, values);
      }
      totals.messages = rows.size;
      totals.success = true;
    } catch {
      unsupported = client.getMetrics().lastOther4xxStatus === 400;
    }
    totals.requests = client.getMetrics().requests;
    totals.retries = client.getMetrics().retries;
    totals.bodyReadMs = Math.round(totals.bodyReadMs);
    totals.jsonParseMs = Math.round(totals.jsonParseMs);
    totals.durationMs = Math.round(performance.now() - started);
    return { totals, rows, unsupported };
  }
  const full = await collect(true, []);
  if (!full.totals.success) return { success: false, full: full.totals };
  const combined = await collect(false, names);
  const singles = metrics();
  const merged = new Map<string, Map<string, string>>();
  let allSinglesSucceeded = true;
  const coverage = new Map<string, number>();
  // Single-id filters are the documented alternative; do not assume OR is supported.
  for (const name of names) {
    if (input.signal.aborted || (!combined.totals.success && !combined.unsupported)) { allSinglesSucceeded = false; break; }
    const one = await collect(false, [name]);
    for (const key of ["requests", "retries", "decodedBytes", "bodyReadMs", "jsonParseMs", "durationMs"] as const) singles[key] += one.totals[key];
    if (!one.totals.success) { allSinglesSucceeded = false; break; }
    for (const [id, values] of one.rows) {
      coverage.set(id, (coverage.get(id) ?? 0) + 1);
      const row = merged.get(id) ?? new Map<string, string>();
      const value = values.get(name.toLowerCase());
      if (value !== undefined) row.set(name.toLowerCase(), value);
      merged.set(id, row);
    }
  }
  singles.messages = [...coverage.values()].filter((count) => count === 4).length;
  singles.success = allSinglesSucceeded;
  const parity = (target: Map<string, Map<string, string>>, valid: boolean, coverageRequired = false) => {
    const headers = names.map((name) => ({ name, fullPresent: 0, targetedPresent: 0, mismatches: 0 }));
    let missingMessages = 0;
    let differingMessages = 0;
    for (const [id, values] of full.rows) {
      const other = valid && (!coverageRequired || coverage.get(id) === 4) ? target.get(id) : undefined;
      if (!other) missingMessages++;
      let differs = !other;
      for (const header of headers) {
        const a = values.get(header.name.toLowerCase());
        const b = other?.get(header.name.toLowerCase());
        if (a !== undefined) header.fullPresent++;
        if (b !== undefined) header.targetedPresent++;
        if (!other || a !== b) { header.mismatches++; differs = true; }
      }
      if (differs) differingMessages++;
    }
    return { headers, missingMessages, differingMessages, exact: valid && full.rows.size > 0 && differingMessages === 0 };
  };
  return { success: full.totals.success, sampleLimit: 100, full: full.totals,
    combined: { ...combined.totals, unsupported: combined.unsupported, parity: parity(combined.rows, combined.totals.success) },
    singlePropertyCollections: { ...singles, parity: parity(merged, allSinglesSucceeded, true) } };
}
