import { NextResponse } from "next/server";
import { ConfigurationError, requireGoogleOAuthConfig } from "@/lib/config";
import { buildGoogleAuthorizationUrl } from "@/lib/server/google-oauth";
import { createOAuthState } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    requireGoogleOAuthConfig();
    const state = await createOAuthState("/app/scan");
    const authorizationUrl = buildGoogleAuthorizationUrl(state);
    const response = NextResponse.redirect(authorizationUrl);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return Response.json({ error: error.message }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
    }
    return Response.json({ error: "Google OAuth could not be started." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
