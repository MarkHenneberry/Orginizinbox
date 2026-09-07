import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookiesMock = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const issued: string[] = [];
  return { jar, issued, cookies: async () => ({
    get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
    set: (name: string, value: string, options: { maxAge?: number }) => {
      if (options.maxAge === 0) jar.delete(name);
      else {
        jar.set(name, value);
        issued.push(value);
      }
    }
  }) };
});
vi.mock("next/headers.js", () => ({ cookies: cookiesMock.cookies }));
vi.mock("@/lib/config", () => ({ env: { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") } }));
vi.mock("@/lib/server/db", async () => {
  const { createSessionConnectionFixture } = await import("./fixtures/session-connection");
  const fixture = createSessionConnectionFixture();
  return { prisma: fixture.client, fixture };
});

import { clearSessionCookie, getSession, SESSION_COOKIE, setSessionCookie } from "@/lib/server/session";
import { signValue, verifySignedValue } from "@/lib/server/crypto";

const { fixture } = await import("@/lib/server/db") as unknown as {
  fixture: ReturnType<typeof import("./fixtures/session-connection").createSessionConnectionFixture>;
};
const now = new Date("2026-09-07T12:00:00Z");
const lifetime = 7 * 24 * 60 * 60 * 1000;
async function issue(userId = "user-1", providerConnectionId = "connection-1") {
  await setSessionCookie({ userId, providerConnectionId, createdAt: Date.now() });
  return cookiesMock.jar.get(SESSION_COOKIE)!;
}
function writePayload(payload: unknown) {
  cookiesMock.jar.set(SESSION_COOKIE, signValue(Buffer.from(JSON.stringify(payload)).toString("base64url")));
}

describe("server session security", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    fixture.reset();
    vi.clearAllMocks();
    cookiesMock.jar.clear();
    cookiesMock.issued.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("expires a copied signed cookie at exactly seven days", async () => {
    const cookie = await issue();
    vi.setSystemTime(now.getTime() + lifetime - 1);
    await expect(getSession()).resolves.toMatchObject({ userId: "user-1" });
    vi.setSystemTime(now.getTime() + lifetime);
    cookiesMock.jar.set(SESSION_COOKIE, cookie);
    await expect(getSession()).resolves.toBeNull();
  });

  it.each([undefined, null, "yesterday", -1, 1.5, Number.MAX_SAFE_INTEGER, now.getTime() + 1])(
    "rejects invalid or future issuance %s", async (createdAt) => {
      const cookie = await issue();
      const payload = JSON.parse(Buffer.from(verifySignedValue(cookie)!, "base64url").toString());
      writePayload({ ...payload, createdAt });
      await expect(getSession()).resolves.toBeNull();
    }
  );

  it("rejects legacy, malformed and tampered cookies", async () => {
    writePayload({ userId: "user-1", providerConnectionId: "connection-1", createdAt: Date.now() });
    await expect(getSession()).resolves.toBeNull();
    writePayload(null);
    await expect(getSession()).resolves.toBeNull();
    const cookie = await issue();
    cookiesMock.jar.set(SESSION_COOKIE, `${cookie}x`);
    await expect(getSession()).resolves.toBeNull();
  });

  it("rejects an old generation after reconnect without expiring other connections", async () => {
    const otherUser = await issue("user-2", "other-connection");
    const otherProvider = await issue("user-1", "connection-2");
    const old = await issue();
    const current = await issue();
    cookiesMock.jar.set(SESSION_COOKIE, old);
    await expect(getSession()).resolves.toBeNull();
    await clearSessionCookie();
    for (const cookie of [current, otherUser, otherProvider]) {
      cookiesMock.jar.set(SESSION_COOKIE, cookie);
      await expect(getSession()).resolves.not.toBeNull();
    }
  });

  it("revokes a copied cookie when the current session is cleared", async () => {
    const cookie = await issue();
    await clearSessionCookie();
    cookiesMock.jar.set(SESSION_COOKIE, cookie);
    await expect(getSession()).resolves.toBeNull();
  });

  it("binds both issuance and validation to the exact connection owner", async () => {
    await expect(issue("user-2", "connection-1")).rejects.toThrow();
    const cookie = await issue();
    const payload = JSON.parse(Buffer.from(verifySignedValue(cookie)!, "base64url").toString());
    writePayload({ ...payload, userId: "user-2" });
    await expect(getSession()).resolves.toBeNull();
  });

  it("invalidates disconnected or credential-cleared connections but allows ordinary refresh", async () => {
    await issue();
    const row = fixture.rows.get("connection-1")!;
    row.tokenVersion += 1;
    row.encryptedAccessToken = "refreshed-access";
    await expect(getSession()).resolves.not.toBeNull();
    row.disconnectedAt = now;
    await expect(getSession()).resolves.toBeNull();
    row.disconnectedAt = null;
    row.encryptedAccessToken = null;
    await expect(getSession()).resolves.toBeNull();
  });

  it("does not authenticate from the signature when the database is unavailable", async () => {
    await issue();
    fixture.client.providerConnection.findFirst.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(getSession()).rejects.toThrow("Database unavailable");
  });

  it("allows only the last committed generation after concurrent session issuance", async () => {
    await Promise.all([issue(), issue()]);
    const cookies = cookiesMock.issued;
    expect(new Set(cookies).size).toBe(2);
    const generation = fixture.rows.get("connection-1")!.sessionGeneration;
    let accepted = 0;
    for (const cookie of cookies) {
      cookiesMock.jar.set(SESSION_COOKIE, cookie);
      const payload = JSON.parse(Buffer.from(verifySignedValue(cookie)!, "base64url").toString());
      const valid = Boolean(await getSession());
      expect(valid).toBe(payload.sessionGeneration === generation);
      if (valid) accepted += 1;
    }
    expect(accepted).toBe(1);
  });
});
