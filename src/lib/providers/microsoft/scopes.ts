export const microsoftRequiredMailScope = "https://graph.microsoft.com/Mail.ReadWrite";
export const microsoftRequiredImapScope = "https://outlook.office.com/IMAP.AccessAsUser.All";

export const microsoftRequestedScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  microsoftRequiredMailScope
] as const;

export const microsoftImapRequestedScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  microsoftRequiredImapScope
] as const;

export function hasRequiredMicrosoftMailScope(scope: string | null | undefined) {
  if (!scope) return false;
  return normalizeMicrosoftScopes(scope).some((value) => value === "mail.readwrite");
}

export function normalizeMicrosoftScopeString(scope: string) {
  return normalizeMicrosoftScopes(scope).join(" ");
}

export function hasRequiredMicrosoftImapScope(scope: string | null | undefined) {
  if (!scope) return false;
  return normalizeMicrosoftScopes(scope).some((value) => value === "imap.accessasuser.all");
}

function normalizeMicrosoftScopes(scope: string) {
  let decoded = scope;
  try {
    decoded = decodeURIComponent(scope);
  } catch {
    // A normal scope response is already decoded.
  }
  return decoded
    .split(/\s+/)
    .map((value) => value.trim().toLowerCase()
      .replace(/^https:\/\/graph\.microsoft\.com\//, "")
      .replace(/^https:\/\/outlook\.office\.com\//, ""))
    .filter(Boolean);
}
