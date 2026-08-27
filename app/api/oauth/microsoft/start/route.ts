import { ConfigurationError, env, requireMicrosoftOAuthConfig, runtimeConfig } from "@/lib/config";
import { microsoftScopes } from "@/lib/providers/microsoft/provider";

export async function GET() {
  try {
    if (process.env.NODE_ENV === "production" || !runtimeConfig.microsoftOAuthDevEnabled) {
      return Response.json({ error: "Microsoft OAuth is not enabled for normal product navigation." }, { status: 404 });
    }
    requireMicrosoftOAuthConfig();
    const authorizationUrl = new URL(`https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize`);
    authorizationUrl.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID ?? "");
    authorizationUrl.searchParams.set("redirect_uri", env.MICROSOFT_REDIRECT_URI ?? "");
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("response_mode", "query");
    authorizationUrl.searchParams.set("scope", microsoftScopes.scan.join(" "));
    return Response.redirect(authorizationUrl);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    return Response.json({ error: "Microsoft OAuth could not be started." }, { status: 500 });
  }
}
