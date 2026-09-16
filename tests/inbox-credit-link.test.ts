import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { completeInboxLink } from "@/lib/billing/inbox-link";
import { POST } from "../app/api/billing/link-inbox/route";
import { environment } from "./fixtures/credit-billing";

const mocks = vi.hoisted(() => ({ intent: vi.fn(), source: vi.fn(), user: vi.fn(), members: vi.fn(), funded: vi.fn(), jobs: vi.fn(), states: vi.fn(),
  createAccount: vi.fn(), updateUser: vi.fn(), consume: vi.fn(), create: vi.fn(), purge: vi.fn(), session: vi.fn(), oauth: vi.fn(), url: vi.fn() }));
vi.mock("@/lib/server/db", () => {
  const tx = { inboxLinkIntent: { findUnique: mocks.intent, updateMany: mocks.consume, create: mocks.create, deleteMany: mocks.purge },
    providerConnection: { count: mocks.source }, user: { findUniqueOrThrow: mocks.user, count: mocks.members, update: mocks.updateUser },
    billingAccount: { create: mocks.createAccount }, creditPurchase: { count: mocks.funded }, creditJobAccounting: { count: mocks.jobs }, cleanupJobState: { count: mocks.states } };
  return { prisma: { ...tx, $transaction: (fn: (input: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("@/lib/server/session", () => ({ getSession: mocks.session, createOAuthState: mocks.oauth, appSessionCookieOptions: () => ({ maxAge: 7 * 86400 }) }));
vi.mock("@/lib/config", () => ({ runtimeConfig: { gmailAvailable: true, microsoftAvailable: true }, requireGoogleOAuthConfig: vi.fn(), requireMicrosoftOAuthConfig: vi.fn() }));
vi.mock("@/lib/server/google-oauth", () => ({ buildGoogleAuthorizationUrl: mocks.url }));
vi.mock("@/lib/server/microsoft-oauth", () => ({ buildMicrosoftAuthorizationUrl: mocks.url, createMicrosoftOAuthAttemptSecrets: () => ({ codeVerifier: "verifier", codeChallenge: "challenge", nonce: "nonce" }) }));
beforeEach(() => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  mocks.intent.mockResolvedValue({ id: "intent", sourceUserId: "original", sourceConnectionId: "connection", sourceGeneration: "generation",
    provider: "microsoft", expiresAt: new Date(Date.now() + 60000), consumedAt: null });
  mocks.source.mockResolvedValue(1);
  mocks.user.mockImplementation(async ({ where }) => where.id === "original" ? { id: "original", creditOwnerId: "root" } : { id: "target", creditOwnerId: null, billingAccount: null });
  for (const mock of [mocks.members, mocks.funded, mocks.jobs, mocks.states]) mock.mockResolvedValue(0);
  mocks.createAccount.mockResolvedValue({}); mocks.consume.mockResolvedValue({ count: 1 });
  mocks.session.mockResolvedValue({ userId: "original", providerConnectionId: "connection", sessionGeneration: "generation", createdAt: Date.now() });
  mocks.oauth.mockResolvedValue("oauth-state"); mocks.url.mockReturnValue("https://login.example.test/authorize");
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const request = (body: object, origin = environment.NEXT_PUBLIC_APP_URL) => new Request(`${environment.NEXT_PUBLIC_APP_URL}/api/billing/link-inbox`, {
  method: "POST", headers: { origin }, body: JSON.stringify(body)
});

describe("explicit authenticated inbox linking", () => {
  it("binds the intent to the validated source session and OAuth provider, not submitted account IDs", async () => {
    const response = await POST(request({ provider: "microsoft", confirm: true, userId: "attacker", creditOwnerId: "attacker" }));
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceUserId: "original", sourceConnectionId: "connection", sourceGeneration: "generation", provider: "microsoft" }) });
    expect(mocks.oauth).toHaveBeenCalledWith("/app/account?linked=1", expect.objectContaining({ linkIntentId: expect.any(String), provider: "microsoft", nonce: "nonce", codeVerifier: "verifier" }));
  });
  it("requires same origin, authentication and explicit confirmation", async () => {
    expect((await POST(request({ provider: "gmail", confirm: true }, "https://attacker.test"))).status).toBe(403);
    expect((await POST(request({ provider: "gmail" }))).status).toBe(400);
    mocks.session.mockResolvedValue(null);
    expect((await POST(request({ provider: "gmail", confirm: true }))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("shares the root wallet without changing provider connections or merging identities", async () => {
    await completeInboxLink("intent", "target", "microsoft");
    expect(mocks.updateUser).toHaveBeenCalledExactlyOnceWith({ where: { id: "target" }, data: { creditOwnerId: "root" } });
    expect(mocks.createAccount).toHaveBeenCalledExactlyOnceWith({ data: { userId: "target" } });
    expect(mocks.source).toHaveBeenCalledWith({ where: expect.objectContaining({ sessionGeneration: "generation", disconnectedAt: null }) });
  });
  it.each(["expired", "consumed", "provider", "disconnected"])("rejects %s intents before linking", async (reason) => {
    if (reason === "expired") mocks.intent.mockResolvedValue({ provider: "microsoft", expiresAt: new Date(0) });
    if (reason === "consumed") mocks.intent.mockResolvedValue({ provider: "microsoft", consumedAt: new Date() });
    if (reason === "disconnected") mocks.source.mockResolvedValue(0);
    await expect(completeInboxLink("intent", "target", reason === "provider" ? "gmail" : "microsoft")).rejects.toThrow();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it.each(["funded", "members", "cleanup", "checkout-race", "other-account"])("refuses %s rather than moving financial ownership", async (reason) => {
    if (reason === "funded") mocks.funded.mockResolvedValue(1);
    if (reason === "members") mocks.members.mockResolvedValue(1);
    if (reason === "cleanup") mocks.states.mockResolvedValue(1);
    if (reason === "checkout-race") mocks.createAccount.mockRejectedValue(new Error("unique billing row claimed by checkout"));
    if (reason === "other-account") mocks.user.mockImplementation(async ({ where }) => where.id === "original" ? { id: "original" } : { id: "target", creditOwnerId: "unrelated" });
    await expect(completeInboxLink("intent", "target", "microsoft")).rejects.toThrow();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it("allows already-linked identities and rejects a lost consumption CAS", async () => {
    mocks.user.mockImplementation(async ({ where }) => ({ id: where.id, creditOwnerId: "root" }));
    await completeInboxLink("intent", "target", "microsoft"); expect(mocks.updateUser).not.toHaveBeenCalled();
    mocks.consume.mockResolvedValue({ count: 0 });
    await expect(completeInboxLink("intent", "target", "microsoft")).rejects.toThrow("changed");
  });
});
