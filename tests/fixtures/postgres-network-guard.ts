import { afterAll, expect, vi } from "vitest";
import http from "node:http";
import https from "node:https";

const databaseHost = new URL(process.env.DATABASE_URL!).hostname;
let blocked = 0;
function check(host: string) {
  if (host === databaseHost) return;
  blocked++;
  throw new Error("Non-database network request blocked by Postgres test isolation.");
}
const fetch = globalThis.fetch;
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
  check(new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname);
  return fetch(input, init);
});
// Stripe uses node:https; Graph uses fetch. IMAP is blocked at the module boundary below.
for (const transport of [http, https]) {
  const original = transport.request;
  vi.spyOn(transport, "request").mockImplementation(((input: string | URL | http.RequestOptions, ...args: unknown[]) => {
    check(typeof input === "string" || input instanceof URL ? new URL(input).hostname : input.hostname ?? input.host ?? "");
    return Reflect.apply(original, transport, [input, ...args]);
  }) as typeof original);
}
vi.mock("imapflow", () => ({ ImapFlow: class { constructor() { throw new Error("IMAP is prohibited in Postgres integration tests."); } } }));
afterAll(() => {
  expect(blocked, "No provider HTTP attempts are permitted").toBe(0);
  vi.unstubAllGlobals();
});
