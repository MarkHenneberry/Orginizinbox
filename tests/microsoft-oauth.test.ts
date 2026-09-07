import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  env: {
    MICROSOFT_CLIENT_ID: "microsoft-client-id",
    MICROSOFT_CLIENT_SECRET: "server-secret",
    MICROSOFT_REDIRECT_URI: "http://localhost:3000/api/oauth/microsoft/callback",
    MICROSOFT_TENANT_ID: "common"
  },
  requireMicrosoftOAuthConfig: vi.fn()
}));

const persistence = vi.hoisted(() => ({
  create: vi.fn(),
  upsert: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  userUpsert: vi.fn(),
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  sha256Base64Url: vi.fn((value: string) => `hash:${value}`)
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => config);
vi.mock("@/lib/server/crypto", () => ({
  encryptSecret: persistence.encryptSecret,
  sha256Base64Url: persistence.sha256Base64Url
}));
vi.mock("@/lib/server/db", () => {
  const transaction = {
    providerConnection: {
      create: persistence.create,
      findFirst: persistence.findFirst,
      update: persistence.update,
      updateMany: persistence.updateMany,
      upsert: persistence.upsert
    },
    user: { upsert: persistence.userUpsert }
  };
  return {
    prisma: {
      ...transaction,
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    }
  };
});

import {
  buildMicrosoftAuthorizationUrl,
  createMicrosoftOAuthAttemptSecrets,
  exchangeMicrosoftCode,
  MicrosoftIdentityValidationError,
  MicrosoftImapScopeNotGrantedError,
  MicrosoftRefreshTokenMissingError,
  MicrosoftScopeNotGrantedError,
  MicrosoftTokenResponseError,
  refreshMicrosoftAccessToken,
  refreshMicrosoftImapAccessToken,
  saveMicrosoftImapCredentials,
  upsertMicrosoftConnection,
  verifyMicrosoftImapTokenResponse,
  verifyMicrosoftTokenResponse
} from "@/lib/server/microsoft-oauth";
import {
  microsoftImapRequestedScopes,
  microsoftRequestedScopes
} from "@/lib/providers/microsoft/scopes";

const fetchMock = vi.fn<typeof fetch>();

describe("Microsoft OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    persistence.userUpsert.mockResolvedValue({ id: "user-1" });
    persistence.create.mockResolvedValue({ id: "microsoft-connection" });
    persistence.update.mockResolvedValue({ id: "microsoft-connection" });
    persistence.updateMany.mockResolvedValue({ count: 1 });
    persistence.upsert.mockResolvedValue({ id: "microsoft-connection" });
  });

  it("builds a separate Outlook IMAP consent URL without mixing Graph resource scopes", () => {
    const url = buildMicrosoftAuthorizationUrl({
      state: "imap-state",
      codeChallenge: "imap-challenge",
      nonce: "imap-nonce",
      flow: "imap"
    });

    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...microsoftImapRequestedScopes]);
    expect(url.searchParams.get("scope")).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(url.searchParams.get("scope")).not.toContain("graph.microsoft.com");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("builds a common-authority authorization URL with exact scopes, state, PKCE, and nonce", () => {
    const url = buildMicrosoftAuthorizationUrl({
      state: "fresh-state",
      codeChallenge: "pkce-challenge",
      nonce: "fresh-nonce"
    });

    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...microsoftRequestedScopes]);
    expect(url.searchParams.get("state")).toBe("fresh-state");
    expect(url.searchParams.get("nonce")).toBe("fresh-nonce");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("creates fresh PKCE and nonce material for every reconnect", () => {
    const first = createMicrosoftOAuthAttemptSecrets();
    const second = createMicrosoftOAuthAttemptSecrets();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.codeChallenge).not.toBe(second.codeChallenge);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it("exchanges a code with the server secret and matching PKCE verifier", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", id_token: "id" }));
    await exchangeMicrosoftCode("authorization-code", "matching-verifier");

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = request?.[1]?.body as URLSearchParams;
    expect(body.get("code")).toBe("authorization-code");
    expect(body.get("code_verifier")).toBe("matching-verifier");
    expect(body.get("client_secret")).toBe("server-secret");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("exchanges IMAP consent for only the Outlook resource scopes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", id_token: "id" }));
    await exchangeMicrosoftCode("imap-code", "imap-verifier", "imap");

    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("scope")?.split(" ")).toEqual([...microsoftImapRequestedScopes]);
    expect(body.get("scope")).not.toContain("graph.microsoft.com");
  });

  it("validates a signed organizational or personal-account ID token without calling Graph profile APIs", async () => {
    const signed = signedIdToken({ nonce: "expected-nonce" });
    mockOidc(signed.publicJwk);
    const verified = await verifyMicrosoftTokenResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: signed.token,
      expires_in: 3600,
      scope: "Mail.ReadWrite"
    }, "expected-nonce");

    expect(verified.identity).toEqual({
      tenantId: signed.tenantId,
      subject: "microsoft-subject",
      email: "person@example.test"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("graph.microsoft.com/v1.0"))).toBe(false);
  });

  it("fails closed for missing mail scope, refresh token, or invalid nonce", async () => {
    await expect(verifyMicrosoftTokenResponse({
      access_token: "access",
      refresh_token: "refresh",
      id_token: "unused",
      scope: "Mail.Read"
    }, "nonce")).rejects.toBeInstanceOf(MicrosoftScopeNotGrantedError);
    await expect(verifyMicrosoftTokenResponse({
      access_token: "access",
      id_token: "unused",
      scope: "Mail.ReadWrite"
    }, "nonce")).rejects.toBeInstanceOf(MicrosoftRefreshTokenMissingError);

    await expect(verifyMicrosoftTokenResponse({
      refresh_token: "refresh",
      id_token: "unused",
      scope: "Mail.ReadWrite"
    }, "nonce")).rejects.toBeInstanceOf(MicrosoftTokenResponseError);

    const signed = signedIdToken({ nonce: "token-nonce" });
    mockOidc(signed.publicJwk);
    await expect(verifyMicrosoftTokenResponse({
      access_token: "access",
      refresh_token: "refresh",
      id_token: signed.token,
      scope: "Mail.ReadWrite"
    }, "different-nonce")).rejects.toBeInstanceOf(MicrosoftIdentityValidationError);
  });

  it("rejects an explicit token response that omits the requested IMAP permission", async () => {
    await expect(verifyMicrosoftImapTokenResponse({
      access_token: "access",
      refresh_token: "refresh",
      id_token: "unused",
      scope: "offline_access"
    }, "nonce")).rejects.toBeInstanceOf(MicrosoftImapScopeNotGrantedError);
  });

  it("rotates refresh credentials without making a mail request", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      scope: "Mail.ReadWrite",
      expires_in: 3600
    }));
    await refreshMicrosoftAccessToken("old-refresh");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/oauth2/v2.0/token");
    expect(String(url)).not.toContain("graph.microsoft.com");
    expect((init?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
  });

  it("refreshes the Outlook IMAP resource without requesting Graph access", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      access_token: "new-imap-access",
      refresh_token: "new-imap-refresh",
      scope: "IMAP.AccessAsUser.All",
      expires_in: 3600
    }));
    await refreshMicrosoftImapAccessToken("old-imap-refresh");
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("scope")).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(body.get("scope")).not.toContain("graph.microsoft.com");
  });

  it("stores IMAP credentials only on the matching connected Microsoft identity", async () => {
    await saveMicrosoftImapCredentials({
      userId: "user-1",
      providerConnectionId: "connection-1",
      tokens: {
        access_token: "imap-access",
        refresh_token: "imap-refresh",
        id_token: "verified-id-token",
        scope: "imap.accessasuser.all offline_access",
        expires_in: 3600,
        identity: {
          tenantId: "11111111-1111-4111-8111-111111111111",
          subject: "microsoft-subject"
        }
      }
    });

    expect(persistence.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "connection-1",
        userId: "user-1",
        provider: "microsoft",
        mailboxExternalIdHash: "hash:11111111-1111-4111-8111-111111111111:microsoft-subject"
      }),
      data: expect.objectContaining({
        encryptedImapAccessToken: "encrypted:imap-access",
        encryptedImapRefreshToken: "encrypted:imap-refresh",
        imapScope: "imap.accessasuser.all offline_access"
      })
    });
  });

  it("persists encrypted Microsoft credentials without touching a Gmail connection", async () => {
    await upsertMicrosoftConnection({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "verified-id-token",
      scope: "mail.readwrite",
      expires_in: 3600,
      identity: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        subject: "microsoft-subject",
        email: "Person@Example.Test"
      }
    });

    expect(persistence.upsert).toHaveBeenCalledWith({
      where: { userId_provider: { userId: "user-1", provider: "microsoft" } },
      update: expect.objectContaining({
        encryptedAccessToken: "encrypted:access-token",
        encryptedRefreshToken: "encrypted:refresh-token",
        encryptedAccountEmail: "encrypted:person@example.test"
      }),
      create: expect.objectContaining({
        userId: "user-1",
        provider: "microsoft",
        encryptedAccessToken: "encrypted:access-token",
        encryptedRefreshToken: "encrypted:refresh-token",
        encryptedAccountEmail: "encrypted:person@example.test"
      })
    });
    expect(JSON.stringify(persistence.upsert.mock.calls)).not.toContain('"provider":"gmail"');
  });

  it("uses stable Microsoft identity for simultaneous OAuth callbacks", async () => {
    const tokens = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "verified-id-token",
      scope: "mail.readwrite",
      expires_in: 3600,
      identity: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        subject: "microsoft-subject",
        email: "Person@Example.Test"
      }
    };

    await Promise.all([upsertMicrosoftConnection(tokens), upsertMicrosoftConnection(tokens)]);

    expect(persistence.userUpsert).toHaveBeenCalledWith({
      where: { microsoftIdentityHash: "hash:11111111-1111-4111-8111-111111111111:microsoft-subject" },
      update: {},
      create: { microsoftIdentityHash: "hash:11111111-1111-4111-8111-111111111111:microsoft-subject" }
    });
    expect(persistence.upsert).toHaveBeenCalledTimes(2);
    expect(persistence.upsert.mock.calls.every(([input]) =>
      input.where.userId_provider.userId === "user-1" && input.where.userId_provider.provider === "microsoft"
    )).toBe(true);
    expect(persistence.create).not.toHaveBeenCalled();
  });

  it("keeps same-email identities and tenants separate, and reconnects after email changes or removal", async () => {
    const owners = new Map<string, { id: string }>();
    persistence.userUpsert.mockImplementation(async ({ where }) => {
      const key = where.microsoftIdentityHash;
      expect(typeof key).toBe("string");
      expect(where).not.toHaveProperty("emailHash");
      if (!owners.has(key)) owners.set(key, { id: `owner-${owners.size}` });
      return owners.get(key);
    });
    const connect = (tenantId: string, subject: string, email?: string) => upsertMicrosoftConnection({
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "verified-id-token",
      scope: "mail.readwrite",
      identity: { tenantId, subject, email }
    });
    const first = await connect("tenant-a", "subject-a", "same@example.test");
    const second = await connect("tenant-a", "subject-b", "same@example.test");
    const otherTenant = await connect("tenant-b", "subject-a", "same@example.test");
    expect(new Set([first.user.id, second.user.id, otherTenant.user.id]).size).toBe(3);
    expect((await connect("tenant-a", "subject-a", "changed@example.test")).user.id).toBe(first.user.id);
    expect((await connect("tenant-a", "subject-a")).user.id).toBe(first.user.id);
    expect(persistence.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { userId_provider: { userId: first.user.id, provider: "microsoft" } },
      update: expect.objectContaining({ encryptedAccountEmail: null, sessionGeneration: null, disconnectedAt: null })
    }));
  });

  it("preserves migrated ownership on reconnect and invalidates the previous session", async () => {
    const identity = { tenantId: "tenant", subject: "subject", email: "new@example.test" };
    persistence.userUpsert.mockImplementation(async ({ where }) => {
      expect(where).toEqual({ microsoftIdentityHash: "hash:tenant:subject" });
      return { id: "migrated-user" };
    });
    await upsertMicrosoftConnection({
      access_token: "new-access", refresh_token: "new-refresh", id_token: "verified",
      scope: "mail.readwrite", identity
    });
    expect(persistence.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_provider: { userId: "migrated-user", provider: "microsoft" } },
      update: expect.objectContaining({ sessionGeneration: null, disconnectedAt: null })
    }));
  });

  it("keeps secrets server-side and excludes send, attachment, and directory permissions", () => {
    const envExample = readFileSync(".env.example", "utf8");
    const configSource = readFileSync("src/lib/config.ts", "utf8");
    const serverSource = readFileSync("src/lib/server/microsoft-oauth.ts", "utf8");
    expect(envExample).toContain('MICROSOFT_TENANT_ID="common"');
    expect(`${envExample}\n${configSource}`).not.toMatch(/NEXT_PUBLIC_MICROSOFT_(CLIENT_SECRET|CLIENT_ID)/);
    expect(microsoftRequestedScopes).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "https://graph.microsoft.com/Mail.ReadWrite"
    ]);
    expect(microsoftRequestedScopes.join(" ")).not.toMatch(/Mail\.Send|Files\.|Directory\.|\.default/i);
    expect(microsoftImapRequestedScopes).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "https://outlook.office.com/IMAP.AccessAsUser.All"
    ]);
    expect(serverSource).not.toMatch(/\/me\/messages|permanentDelete|attachments|sendMail/);
  });
});

function signedIdToken({ nonce }: { nonce: string }) {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const claims = encode({
    aud: "microsoft-client-id",
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    tid: tenantId,
    sub: "microsoft-subject",
    nonce,
    ver: "2.0",
    email: "person@example.test",
    exp: Math.floor(Date.now() / 1000) + 300
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  return { tenantId, publicJwk, token: `${header}.${claims}.${signature}` };
}

function mockOidc(publicJwk: JsonWebKey) {
  fetchMock
    .mockResolvedValueOnce(Response.json({
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys"
    }))
    .mockResolvedValueOnce(Response.json({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig", issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" }]
    }));
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
