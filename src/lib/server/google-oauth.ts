import "server-only";
import { ImapFlow } from "imapflow";
import { env, requireGoogleOAuthConfig } from "@/lib/config";
import {
  createGoogleAuthorizationUrl,
  gmailRequiredImapScope,
  googleIdentityScopes,
  hasRequiredGmailImapScope
} from "@/lib/providers/gmail/scopes";
import type { SafeFallbackErrorClass } from "@/lib/server/oauth-callback-diagnostics";
import { encryptSecret, sha256Base64Url } from "@/lib/server/crypto";
import { prisma } from "@/lib/server/db";

type GoogleTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

type VerifiedGoogleTokenResponse = GoogleTokenResponse & {
  scope: string;
  scopeVerification: GoogleScopeVerificationEvidence;
};

export type GoogleUserInfo = {
  sub: string;
  email?: string;
  name?: string;
};

export type GoogleScopeVerificationEvidence = {
  source: "explicit" | "imap_probe";
  result: "success" | "missing" | "error";
  attempts: 0 | 1 | 2;
  errorClass: SafeFallbackErrorClass;
  timeout: boolean;
};

const imapProbeAttempts = 2;
const imapProbeAttemptTimeoutMs = 7_000;
const imapProbeRetryDelayMs = 150;
const transientImapErrorCodes = new Set([
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETHROTTLE"
]);

export { googleIdentityScopes, hasRequiredGmailImapScope };

export const gmailMissingImapScopeMessage = "Gmail IMAP permission was not granted. Reconnect Gmail and approve Gmail access.";

export function buildGoogleAuthorizationUrl(state: string): URL {
  requireGoogleOAuthConfig();
  return createGoogleAuthorizationUrl({
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    redirectUri: env.GOOGLE_REDIRECT_URI ?? "",
    state
  });
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  requireGoogleOAuthConfig();
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: env.GOOGLE_REDIRECT_URI ?? "",
        grant_type: "authorization_code"
      })
    });
  } catch {
    throw new GoogleTokenExchangeError();
  }

  if (!response.ok) {
    throw new GoogleTokenExchangeError(response.status);
  }

  try {
    return (await response.json()) as GoogleTokenResponse;
  } catch {
    throw new GoogleTokenExchangeError();
  }
}

export async function verifyGoogleTokenScopes(tokens: GoogleTokenResponse, accountEmail?: string): Promise<VerifiedGoogleTokenResponse> {
  if (!tokens.access_token) {
    throw new GoogleTokenScopeVerificationError();
  }

  if (typeof tokens.scope === "string") {
    if (!hasRequiredGmailImapScope(tokens.scope)) throw new GmailImapScopeNotGrantedError();
    return {
      ...tokens,
      scope: normalizeScope(tokens.scope),
      scopeVerification: { source: "explicit", result: "success", attempts: 0, errorClass: "NONE", timeout: false }
    };
  }

  if (!accountEmail) throw new GoogleTokenScopeVerificationError();
  const scopeVerification = await verifyGoogleImapCapability(tokens.access_token, accountEmail);
  return {
    ...tokens,
    scope: normalizeScope([...googleIdentityScopes, gmailRequiredImapScope].join(" ")),
    scopeVerification
  };
}

export async function verifyGoogleImapCapability(accessToken: string, accountEmail: string): Promise<GoogleScopeVerificationEvidence> {
  for (let attempt = 1; attempt <= imapProbeAttempts; attempt += 1) {
    try {
      await runGoogleImapCapabilityProbe(accessToken, accountEmail);
      return { source: "imap_probe", result: "success", attempts: attempt as 1 | 2, errorClass: "NONE", timeout: false };
    } catch (error) {
      const classification = classifyImapProbeError(error);
      const evidence: GoogleScopeVerificationEvidence = {
        source: "imap_probe",
        result: classification.authenticationDenied ? "missing" : "error",
        attempts: attempt as 1 | 2,
        errorClass: classification.errorClass,
        timeout: classification.timeout
      };

      if (classification.authenticationDenied) throw new GoogleImapAuthenticationDeniedError(evidence);
      if (!classification.transient || attempt === imapProbeAttempts) throw new GoogleTokenScopeVerificationError(evidence);
      await delay(imapProbeRetryDelayMs);
    }
  }

  throw new GoogleTokenScopeVerificationError();
}

async function runGoogleImapCapabilityProbe(accessToken: string, accountEmail: string) {
  const client = new ImapFlow({
    host: env.GMAIL_IMAP_HOST,
    port: env.GMAIL_IMAP_PORT,
    secure: true,
    logger: false,
    verifyOnly: true,
    includeMailboxes: false,
    disableAutoIdle: true,
    disableCompression: true,
    disableAutoEnable: true,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
    auth: {
      user: accountEmail,
      accessToken
    },
    tls: {
      rejectUnauthorized: true
    }
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          client.close();
          reject(new GoogleImapProbeTimeoutError());
        }, imapProbeAttemptTimeoutMs);
      })
    ]);
  } catch (error) {
    client.close();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function classifyImapProbeError(error: unknown) {
  const details = errorDetails(error);
  const authenticationDenied = details.authenticationFailed === true;
  const timeout = details.name === "GoogleImapProbeTimeoutError" || details.code === "CONNECT_TIMEOUT" || details.code === "GREETING_TIMEOUT" || details.code === "ETIMEDOUT" || details.code === "ESOCKETTIMEDOUT";
  const transient = !authenticationDenied && (timeout || transientImapErrorCodes.has(details.code ?? "") || details.responseStatus === "BYE");
  let errorClass: SafeFallbackErrorClass = "UNKNOWN";
  if (authenticationDenied) errorClass = "AUTHENTICATION_DENIED";
  else if (timeout) errorClass = "TIMEOUT";
  else if (details.code === "ETHROTTLE") errorClass = "THROTTLED";
  else if (transient) errorClass = "NETWORK";
  else if (details.responseStatus) errorClass = "PROTOCOL";
  return { authenticationDenied, errorClass, timeout, transient };
}

function errorDetails(error: unknown): { name?: string; code?: string; responseStatus?: string; authenticationFailed?: boolean } {
  if (!error || typeof error !== "object") return {};
  const value = error as Record<string, unknown>;
  return {
    name: typeof value.name === "string" ? value.name : undefined,
    code: typeof value.code === "string" ? value.code : undefined,
    responseStatus: typeof value.responseStatus === "string" ? value.responseStatus : undefined,
    authenticationFailed: value.authenticationFailed === true
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GoogleImapProbeTimeoutError extends Error {
  constructor() {
    super("Gmail IMAP capability verification timed out.");
    this.name = "GoogleImapProbeTimeoutError";
  }
}

function normalizeScope(scope: string) {
  return scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  requireGoogleOAuthConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    throw new Error(`Google token refresh failed with status ${response.status}.`);
  }

  return (await response.json()) as GoogleTokenResponse;
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Google userinfo failed with status ${response.status}.`);
  }

  return (await response.json()) as GoogleUserInfo;
}

export async function upsertGoogleConnection(tokens: VerifiedGoogleTokenResponse, profile: GoogleUserInfo) {
  if (!tokens.access_token) throw new Error("Google token response did not include an access token.");
  if (!profile.sub) throw new Error("Google profile did not include a stable subject.");
  if (!hasRequiredGmailImapScope(tokens.scope)) throw new GmailImapScopeNotGrantedError();

  const emailHash = profile.email ? sha256Base64Url(profile.email.toLowerCase()) : undefined;
  const providerIdentityHash = sha256Base64Url(profile.sub);
  const tokenExpiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;
  const encryptedAccessToken = encryptSecret(tokens.access_token);
  const encryptedRefreshToken = tokens.refresh_token ? encryptSecret(tokens.refresh_token) : undefined;
  const encryptedAccountEmail = profile.email ? encryptSecret(profile.email.toLowerCase()) : undefined;

  const user = await prisma.user.upsert({
    where: emailHash ? { emailHash } : { emailHash: providerIdentityHash },
    update: {},
    create: {
      emailHash: emailHash ?? providerIdentityHash
    }
  });

  const existingConnection = await prisma.providerConnection.findFirst({
    where: {
      userId: user.id,
      provider: "gmail"
    }
  });

  const connection = existingConnection
    ? await prisma.providerConnection.update({
        where: { id: existingConnection.id },
        data: {
          mailboxExternalIdHash: providerIdentityHash,
          encryptedAccountEmail: encryptedAccountEmail ?? existingConnection.encryptedAccountEmail,
          encryptedAccessToken,
          encryptedRefreshToken: encryptedRefreshToken ?? existingConnection.encryptedRefreshToken,
          tokenExpiresAt,
          scope: tokens.scope,
          disconnectedAt: null
        }
      })
    : await prisma.providerConnection.create({
        data: {
          userId: user.id,
          provider: "gmail",
          mailboxExternalIdHash: providerIdentityHash,
          encryptedAccountEmail,
          encryptedAccessToken,
          encryptedRefreshToken,
          tokenExpiresAt,
          scope: tokens.scope
        }
      });

  return { user, connection };
}

export class GmailImapScopeNotGrantedError extends Error {
  readonly verification: GoogleScopeVerificationEvidence;

  constructor() {
    super(gmailMissingImapScopeMessage);
    this.name = "GmailImapScopeNotGrantedError";
    this.verification = { source: "explicit", result: "missing", attempts: 0, errorClass: "NONE", timeout: false };
  }
}

export class GoogleImapAuthenticationDeniedError extends Error {
  constructor(readonly verification: GoogleScopeVerificationEvidence) {
    super("Gmail IMAP authentication was denied.");
    this.name = "GoogleImapAuthenticationDeniedError";
  }
}

export class GoogleTokenExchangeError extends Error {
  constructor(status?: number) {
    super(status ? `Google token exchange failed with status ${status}.` : "Google token exchange failed.");
    this.name = "GoogleTokenExchangeError";
  }
}

export class GoogleTokenScopeVerificationError extends Error {
  readonly verification: GoogleScopeVerificationEvidence;

  constructor(verification?: GoogleScopeVerificationEvidence) {
    super("Google token scope verification failed.");
    this.name = "GoogleTokenScopeVerificationError";
    this.verification = verification ?? { source: "imap_probe", result: "error", attempts: 0, errorClass: "UNKNOWN", timeout: false };
  }
}

export type GoogleTokenRevocationResult = {
  succeeded: boolean;
  status: number;
};

export async function revokeGoogleToken(token: string): Promise<GoogleTokenRevocationResult> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ token })
  });
  return { succeeded: response.ok, status: response.status };
}
