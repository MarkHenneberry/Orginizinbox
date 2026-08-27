export const gmailRequiredImapScope = "https://mail.google.com/";
export const googleIdentityScopes = ["openid", "email", "profile"] as const;
export const requestedGoogleOAuthScopes = [...googleIdentityScopes, gmailRequiredImapScope] as const;

export function createGoogleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): URL {
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.searchParams.set("client_id", input.clientId);
  authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("prompt", "consent");
  authorizationUrl.searchParams.set("state", input.state);
  authorizationUrl.searchParams.set("scope", requestedGoogleOAuthScopes.join(" "));
  return authorizationUrl;
}

export function parseGrantedScopes(scope: string | undefined): Set<string> {
  return new Set(
    (scope ?? "")
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export function hasRequiredGmailImapScope(scope: string | undefined): boolean {
  return parseGrantedScopes(scope).has(gmailRequiredImapScope);
}
