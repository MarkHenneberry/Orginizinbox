import "server-only";
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import { env, requireMicrosoftOAuthConfig } from "@/lib/config";
import {
  hasRequiredMicrosoftImapScope,
  hasRequiredMicrosoftMailScope,
  microsoftImapRequestedScopes,
  microsoftRequestedScopes,
  normalizeMicrosoftScopeString
} from "@/lib/providers/microsoft/scopes";
import { encryptSecret, sha256Base64Url } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";

const microsoftHost = "login.microsoftonline.com";
const requestTimeoutMs = 10_000;
const allowedClockSkewSeconds = 60;

export type MicrosoftTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

export type MicrosoftIdentity = {
  tenantId: string;
  subject: string;
  email?: string;
};

export type VerifiedMicrosoftTokenResponse = MicrosoftTokenResponse & {
  access_token: string;
  refresh_token: string;
  id_token: string;
  scope: string;
  identity: MicrosoftIdentity;
};

const idTokenHeaderSchema = z.object({
  alg: z.literal("RS256"),
  kid: z.string().min(1)
});

const idTokenClaimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  iss: z.string().url(),
  tid: z.string().uuid(),
  sub: z.string().min(1),
  nonce: z.string().min(1),
  exp: z.number().int(),
  nbf: z.number().int().optional(),
  ver: z.literal("2.0"),
  email: z.string().optional(),
  preferred_username: z.string().optional()
});

const oidcMetadataSchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.string().url()
});

const jwksSchema = z.object({
  keys: z.array(z.object({
    kty: z.literal("RSA"),
    kid: z.string().min(1),
    n: z.string().min(1),
    e: z.string().min(1),
    alg: z.string().optional(),
    use: z.string().optional(),
    issuer: z.string().optional()
  }))
});

export function createMicrosoftOAuthAttemptSecrets() {
  const codeVerifier = randomBytes(48).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    nonce: randomBytes(24).toString("base64url")
  };
}

export function buildMicrosoftAuthorizationUrl(input: {
  state: string;
  codeChallenge: string;
  nonce: string;
  flow?: "graph" | "imap";
}) {
  requireMicrosoftOAuthConfig();
  const url = new URL(`${microsoftAuthorityBase()}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", env.MICROSOFT_REDIRECT_URI ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  const flow = input.flow ?? "graph";
  url.searchParams.set("scope", (flow === "imap" ? microsoftImapRequestedScopes : microsoftRequestedScopes).join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", flow === "imap" ? "consent" : "select_account");
  return url;
}

export async function exchangeMicrosoftCode(
  code: string,
  codeVerifier: string,
  flow: "graph" | "imap" = "graph"
): Promise<MicrosoftTokenResponse> {
  requireMicrosoftOAuthConfig();
  return requestMicrosoftToken(new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID ?? "",
    client_secret: env.MICROSOFT_CLIENT_SECRET ?? "",
    code,
    code_verifier: codeVerifier,
    redirect_uri: env.MICROSOFT_REDIRECT_URI ?? "",
    grant_type: "authorization_code",
    scope: (flow === "imap" ? microsoftImapRequestedScopes : microsoftRequestedScopes).join(" ")
  }), "exchange");
}

export async function refreshMicrosoftAccessToken(refreshToken: string): Promise<MicrosoftTokenResponse> {
  requireMicrosoftOAuthConfig();
  return requestMicrosoftToken(new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID ?? "",
    client_secret: env.MICROSOFT_CLIENT_SECRET ?? "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: microsoftRequestedScopes.join(" ")
  }), "refresh");
}

export async function refreshMicrosoftImapAccessToken(refreshToken: string): Promise<MicrosoftTokenResponse> {
  requireMicrosoftOAuthConfig();
  return requestMicrosoftToken(new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID ?? "",
    client_secret: env.MICROSOFT_CLIENT_SECRET ?? "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: microsoftRequiredImapTokenScopes()
  }), "refresh");
}

async function requestMicrosoftToken(body: URLSearchParams, operation: "exchange" | "refresh") {
  let response: Response;
  try {
    response = await fetch(`${microsoftAuthorityBase()}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch {
    throw operation === "exchange" ? new MicrosoftTokenExchangeError() : new MicrosoftTokenRefreshError();
  }
  if (!response.ok) {
    throw operation === "exchange" ? new MicrosoftTokenExchangeError() : new MicrosoftTokenRefreshError();
  }
  try {
    return (await response.json()) as MicrosoftTokenResponse;
  } catch {
    throw operation === "exchange" ? new MicrosoftTokenExchangeError() : new MicrosoftTokenRefreshError();
  }
}

export async function verifyMicrosoftTokenResponse(
  tokens: MicrosoftTokenResponse,
  expectedNonce: string
): Promise<VerifiedMicrosoftTokenResponse> {
  if (!tokens.access_token || !tokens.id_token) {
    throw new MicrosoftTokenResponseError();
  }
  if (!tokens.refresh_token) throw new MicrosoftRefreshTokenMissingError();
  if (typeof tokens.scope === "string" && !hasRequiredMicrosoftMailScope(tokens.scope)) {
    throw new MicrosoftScopeNotGrantedError();
  }
  const identity = await verifyMicrosoftIdToken(tokens.id_token, expectedNonce);
  return {
    ...tokens,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    scope: typeof tokens.scope === "string"
      ? normalizeMicrosoftScopeString(tokens.scope)
      : microsoftRequestedScopes.join(" "),
    identity
  };
}

export async function verifyMicrosoftImapTokenResponse(
  tokens: MicrosoftTokenResponse,
  expectedNonce: string
): Promise<VerifiedMicrosoftTokenResponse> {
  if (!tokens.access_token || !tokens.id_token) throw new MicrosoftTokenResponseError();
  if (!tokens.refresh_token) throw new MicrosoftRefreshTokenMissingError();
  if (typeof tokens.scope === "string" && !hasRequiredMicrosoftImapScope(tokens.scope)) {
    throw new MicrosoftImapScopeNotGrantedError();
  }
  const identity = await verifyMicrosoftIdToken(tokens.id_token, expectedNonce);
  return {
    ...tokens,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    scope: typeof tokens.scope === "string"
      ? normalizeMicrosoftScopeString(tokens.scope)
      : microsoftImapRequestedScopes.join(" "),
    identity
  };
}

export async function verifyMicrosoftIdToken(idToken: string, expectedNonce: string): Promise<MicrosoftIdentity> {
  try {
    const [encodedHeader, encodedClaims, encodedSignature, ...extra] = idToken.split(".");
    if (!encodedHeader || !encodedClaims || !encodedSignature || extra.length > 0) throw new Error("Malformed token.");
    const header = idTokenHeaderSchema.parse(parseJwtSegment(encodedHeader));
    const claims = idTokenClaimsSchema.parse(parseJwtSegment(encodedClaims));
    const metadata = await fetchMicrosoftJson(
      `${microsoftAuthorityBase()}/v2.0/.well-known/openid-configuration`,
      oidcMetadataSchema
    );
    const expectedIssuer = metadata.issuer.replace("{tenantid}", claims.tid);
    if (claims.iss !== expectedIssuer) throw new Error("Issuer mismatch.");
    assertMicrosoftUrl(metadata.jwks_uri);
    const jwks = await fetchMicrosoftJson(metadata.jwks_uri, jwksSchema);
    const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
    if (!key || (key.alg && key.alg !== "RS256") || (key.use && key.use !== "sig")) throw new Error("Signing key unavailable.");
    if (key.issuer && key.issuer.replace("{tenantid}", claims.tid) !== claims.iss) throw new Error("Signing-key issuer mismatch.");
    const validSignature = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url")
    );
    if (!validSignature) throw new Error("Signature invalid.");
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(env.MICROSOFT_CLIENT_ID ?? "")) throw new Error("Audience mismatch.");
    if (!constantTimeEqual(claims.nonce, expectedNonce)) throw new Error("Nonce mismatch.");
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now - allowedClockSkewSeconds) throw new Error("Token expired.");
    if (claims.nbf && claims.nbf > now + allowedClockSkewSeconds) throw new Error("Token not active.");
    return {
      tenantId: claims.tid,
      subject: claims.sub,
      email: validEmail(claims.email) ?? validEmail(claims.preferred_username)
    };
  } catch (error) {
    if (error instanceof MicrosoftIdentityValidationError) throw error;
    throw new MicrosoftIdentityValidationError();
  }
}

async function fetchMicrosoftJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  assertMicrosoftUrl(url);
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch {
    throw new MicrosoftIdentityValidationError();
  }
  if (!response.ok) throw new MicrosoftIdentityValidationError();
  try {
    return schema.parse(await response.json());
  } catch {
    throw new MicrosoftIdentityValidationError();
  }
}

function assertMicrosoftUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== microsoftHost) throw new MicrosoftIdentityValidationError();
}

function parseJwtSegment(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validEmail(value: string | undefined) {
  return value && z.string().email().safeParse(value).success ? value : undefined;
}

function microsoftAuthorityBase() {
  return `https://${microsoftHost}/${encodeURIComponent(env.MICROSOFT_TENANT_ID)}`;
}

export async function upsertMicrosoftConnection(tokens: VerifiedMicrosoftTokenResponse) {
  const identityKey = `${tokens.identity.tenantId}:${tokens.identity.subject}`;
  const providerIdentityHash = sha256Base64Url(identityKey);
  const normalizedEmail = tokens.identity.email?.toLowerCase();
  return prisma.$transaction(async (transaction) => {
    const user = await transaction.user.upsert({
      where: { microsoftIdentityHash: providerIdentityHash },
      update: {},
      create: { microsoftIdentityHash: providerIdentityHash }
    });
    const encryptedAccountEmail = normalizedEmail ? encryptSecret(normalizedEmail) : null;
    const data = {
      mailboxExternalIdHash: providerIdentityHash,
      encryptedAccountEmail,
      encryptedAccessToken: encryptSecret(tokens.access_token),
      encryptedRefreshToken: encryptSecret(tokens.refresh_token),
      tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined,
      scope: tokens.scope,
      encryptedImapAccessToken: null,
      encryptedImapRefreshToken: null,
      imapTokenExpiresAt: null,
      imapScope: null,
      disconnectedAt: null,
      sessionGeneration: null,
      refreshLeaseOwner: null,
      refreshLeaseExpiresAt: null
    };
    const connection = await transaction.providerConnection.upsert({
      where: { userId_provider: { userId: user.id, provider: "microsoft" } },
      update: { ...data, tokenVersion: { increment: 1 } },
      create: { userId: user.id, provider: "microsoft", ...data, tokenVersion: 0 }
    });
    return { user, connection };
  });
}

export async function saveMicrosoftImapCredentials(input: {
  userId: string;
  providerConnectionId: string;
  tokens: VerifiedMicrosoftTokenResponse;
}) {
  const identityKey = `${input.tokens.identity.tenantId}:${input.tokens.identity.subject}`;
  const identityHash = sha256Base64Url(identityKey);
  const result = await prisma.providerConnection.updateMany({
    where: {
      id: input.providerConnectionId,
      userId: input.userId,
      provider: "microsoft",
      disconnectedAt: null,
      mailboxExternalIdHash: identityHash
    },
    data: {
      encryptedImapAccessToken: encryptSecret(input.tokens.access_token),
      encryptedImapRefreshToken: encryptSecret(input.tokens.refresh_token),
      imapTokenExpiresAt: input.tokens.expires_in
        ? new Date(Date.now() + input.tokens.expires_in * 1000)
        : undefined,
      imapScope: input.tokens.scope,
      tokenVersion: { increment: 1 }
    }
  });
  if (result.count !== 1) throw new MicrosoftIdentityValidationError();
}

export class MicrosoftTokenExchangeError extends Error {
  constructor() {
    super("Microsoft authorization could not be completed.");
    this.name = "MicrosoftTokenExchangeError";
  }
}

export class MicrosoftTokenRefreshError extends Error {
  constructor() {
    super("Microsoft connection needs to be reconnected.");
    this.name = "MicrosoftTokenRefreshError";
  }
}

export class MicrosoftTokenResponseError extends Error {
  constructor() {
    super("Microsoft did not return the credentials required for a persistent connection.");
    this.name = "MicrosoftTokenResponseError";
  }
}

export class MicrosoftRefreshTokenMissingError extends Error {
  constructor() {
    super("Microsoft did not return the refresh token required for a persistent connection.");
    this.name = "MicrosoftRefreshTokenMissingError";
  }
}

export class MicrosoftScopeNotGrantedError extends Error {
  constructor() {
    super("Microsoft mail permission was not granted. Reconnect Microsoft and approve mail access.");
    this.name = "MicrosoftScopeNotGrantedError";
  }
}

export class MicrosoftImapScopeNotGrantedError extends Error {
  constructor() {
    super("Outlook IMAP permission was not granted. Approve Outlook IMAP access for the benchmark.");
    this.name = "MicrosoftImapScopeNotGrantedError";
  }
}

export class MicrosoftIdentityValidationError extends Error {
  constructor() {
    super("Microsoft account identity could not be verified.");
    this.name = "MicrosoftIdentityValidationError";
  }
}

function microsoftRequiredImapTokenScopes() {
  return microsoftImapRequestedScopes
    .filter((scope) => !["openid", "profile", "email"].includes(scope))
    .join(" ");
}
