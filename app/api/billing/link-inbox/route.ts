import { randomUUID } from "node:crypto";
import { getSession, createOAuthState, appSessionCookieOptions } from "@/lib/server/session";
import { prisma } from "@/lib/server/db";
import { requireBillingConfig } from "@/lib/billing/config";
import { runtimeConfig, requireGoogleOAuthConfig, requireMicrosoftOAuthConfig } from "@/lib/config";
import { buildGoogleAuthorizationUrl } from "@/lib/server/google-oauth";
import { buildMicrosoftAuthorizationUrl, createMicrosoftOAuthAttemptSecrets } from "@/lib/server/microsoft-oauth";

export async function POST(request: Request) {
  try {
    const config = requireBillingConfig();
    if (request.headers.get("origin") !== config.origin || new URL(request.url).origin !== config.origin) return Response.json({ error: "Forbidden." }, { status: 403 });
    const session = await getSession();
    if (!session) return Response.json({ error: "Sign in before linking an inbox." }, { status: 401 });
    const body = await request.json();
    const provider = body.provider;
    if (body.confirm !== true || !["gmail", "microsoft"].includes(provider)) return Response.json({ error: "Confirm inbox linking." }, { status: 400 });
    if (provider === "gmail" ? !runtimeConfig.gmailAvailable : !runtimeConfig.microsoftAvailable) return Response.json({ error: "This provider is unavailable." }, { status: 503 });
    if (provider === "gmail") requireGoogleOAuthConfig(); else requireMicrosoftOAuthConfig();
    const linkIntentId = randomUUID();
    await prisma.inboxLinkIntent.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await prisma.inboxLinkIntent.create({ data: { id: linkIntentId, sourceUserId: session.userId,
      sourceConnectionId: session.providerConnectionId, sourceGeneration: session.sessionGeneration, provider,
      expiresAt: new Date(Math.min(Date.now() + 10 * 60_000, session.createdAt + appSessionCookieOptions().maxAge * 1000)) } });
    let url: string;
    if (provider === "gmail") {
      const state = await createOAuthState("/app/account?linked=1", { provider: "google", linkIntentId });
      url = buildGoogleAuthorizationUrl(state).toString();
    } else {
      const attempt = createMicrosoftOAuthAttemptSecrets();
      const state = await createOAuthState("/app/account?linked=1", { provider: "microsoft", codeVerifier: attempt.codeVerifier,
        nonce: attempt.nonce, microsoftFlow: "graph", linkIntentId });
      url = buildMicrosoftAuthorizationUrl({ state, codeChallenge: attempt.codeChallenge, nonce: attempt.nonce, flow: "graph" }).toString();
    }
    return Response.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Inbox linking could not be started. Try again from Account." }, { status: 503 }); }
}
