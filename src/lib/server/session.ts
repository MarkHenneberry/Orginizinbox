import "server-only";
import { cookies } from "next/headers.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "./db";
import { verifySignedValue, signValue } from "./crypto";

export const SESSION_COOKIE = "organizinbox_session";
export const OAUTH_STATE_COOKIE = "organizinbox_oauth_state";

const sessionSchema = z.object({
  userId: z.string().min(1).max(128),
  providerConnectionId: z.string().min(1).max(128),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sessionGeneration: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

type SessionPayload = z.infer<typeof sessionSchema>;

type OAuthStatePayload = {
  state: string;
  createdAt: number;
  returnTo?: string;
  provider?: "google" | "microsoft";
  codeVerifier?: string;
  nonce?: string;
  microsoftFlow?: "graph" | "imap";
};

type OAuthStateOptions = Pick<OAuthStatePayload, "provider" | "codeVerifier" | "nonce" | "microsoftFlow">;

const oauthStateTtlMs = 10 * 60 * 1000;
const sessionTtlSeconds = 60 * 60 * 24 * 7;

export function appSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionTtlSeconds
  };
}

export function oauthStateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: oauthStateTtlMs / 1000
  };
}

function expiredCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  };
}

export async function setSessionCookie(payload: Omit<SessionPayload, "sessionGeneration">) {
  const cookieStore = await cookies();
  const session = sessionSchema.parse({
    ...payload,
    createdAt: Date.now(),
    sessionGeneration: randomBytes(32).toString("hex")
  });
  await prisma.providerConnection.update({
    where: {
      id: session.providerConnectionId,
      userId: session.userId,
      disconnectedAt: null,
      encryptedAccessToken: { not: null }
    },
    data: { sessionGeneration: session.sessionGeneration },
    select: { id: true }
  });
  cookieStore.set(SESSION_COOKIE, signValue(Buffer.from(JSON.stringify(session), "utf8").toString("base64url")), appSessionCookieOptions());
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const signed = cookieStore.get(SESSION_COOKIE)?.value;
  const session = parseSessionCookie(signed);
  if (!session) return null;
  const age = Date.now() - session.createdAt;
  if (age < 0 || age >= sessionTtlSeconds * 1000) return null;
  const connection = await prisma.providerConnection.findFirst({
    where: {
      id: session.providerConnectionId,
      userId: session.userId,
      sessionGeneration: session.sessionGeneration,
      disconnectedAt: null,
      encryptedAccessToken: { not: null }
    },
    select: { id: true }
  });
  return connection ? session : null;
}

function parseSessionCookie(signed: string | undefined): SessionPayload | null {
  if (!signed) return null;
  try {
    const verified = verifySignedValue(signed);
    if (!verified) return null;
    return sessionSchema.parse(JSON.parse(Buffer.from(verified, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  const session = parseSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  try {
    if (session) {
      await prisma.providerConnection.updateMany({
        where: {
          id: session.providerConnectionId,
          userId: session.userId,
          sessionGeneration: session.sessionGeneration
        },
        data: { sessionGeneration: null }
      });
    }
  } finally {
    cookieStore.set(SESSION_COOKIE, "", expiredCookieOptions());
  }
}

export async function createOAuthState(returnTo?: string, options: OAuthStateOptions = {}): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const payload: OAuthStatePayload = {
    state,
    createdAt: Date.now(),
    returnTo,
    ...options
  };
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, signValue(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")), oauthStateCookieOptions());
  return state;
}

export async function consumeOAuthState(
  receivedState: string | null,
  expectedProvider?: OAuthStatePayload["provider"]
): Promise<{
  ok: true;
  returnTo?: string;
  codeVerifier?: string;
  nonce?: string;
  microsoftFlow?: "graph" | "imap";
} | { ok: false; reason: string }> {
  const cookieStore = await cookies();
  const signed = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  cookieStore.set(OAUTH_STATE_COOKIE, "", expiredCookieOptions());
  if (!receivedState) return { ok: false, reason: "Missing OAuth state." };
  if (!signed) return { ok: false, reason: "Missing OAuth state cookie." };
  const verified = verifySignedValue(signed);
  if (!verified) return { ok: false, reason: "Invalid OAuth state cookie." };

  try {
    const payload = JSON.parse(Buffer.from(verified, "base64url").toString("utf8")) as OAuthStatePayload;
    if (Date.now() - payload.createdAt > oauthStateTtlMs) return { ok: false, reason: "OAuth state expired." };
    if (payload.state !== receivedState) return { ok: false, reason: "OAuth state mismatch." };
    if (expectedProvider && payload.provider && payload.provider !== expectedProvider) {
      return { ok: false, reason: "OAuth provider mismatch." };
    }
    return {
      ok: true,
      returnTo: payload.returnTo,
      ...(payload.codeVerifier ? { codeVerifier: payload.codeVerifier } : {}),
      ...(payload.nonce ? { nonce: payload.nonce } : {}),
      ...(payload.microsoftFlow ? { microsoftFlow: payload.microsoftFlow } : {})
    };
  } catch {
    return { ok: false, reason: "Invalid OAuth state payload." };
  }
}

export async function clearOAuthStateCookie() {
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, "", expiredCookieOptions());
}
