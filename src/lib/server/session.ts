import "server-only";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { verifySignedValue, signValue } from "./crypto";

export const SESSION_COOKIE = "organizinbox_session";
export const OAUTH_STATE_COOKIE = "organizinbox_oauth_state";

type SessionPayload = {
  userId: string;
  providerConnectionId?: string;
  createdAt: number;
};

type OAuthStatePayload = {
  state: string;
  createdAt: number;
  returnTo?: string;
};

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

export async function setSessionCookie(payload: SessionPayload) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, signValue(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")), appSessionCookieOptions());
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const signed = cookieStore.get(SESSION_COOKIE)?.value;
  if (!signed) return null;
  const verified = verifySignedValue(signed);
  if (!verified) return null;
  try {
    return JSON.parse(Buffer.from(verified, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", expiredCookieOptions());
}

export async function createOAuthState(returnTo?: string): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const payload: OAuthStatePayload = {
    state,
    createdAt: Date.now(),
    returnTo
  };
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, signValue(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")), oauthStateCookieOptions());
  return state;
}

export async function consumeOAuthState(receivedState: string | null): Promise<{ ok: true; returnTo?: string } | { ok: false; reason: string }> {
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
    return { ok: true, returnTo: payload.returnTo };
  } catch {
    return { ok: false, reason: "Invalid OAuth state payload." };
  }
}

export async function clearOAuthStateCookie() {
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, "", expiredCookieOptions());
}
