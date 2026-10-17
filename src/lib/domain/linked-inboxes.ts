export type LinkedInbox = {
  id: string;
  provider: "gmail" | "microsoft";
  email: string | null;
  active: boolean;
  state: "ready" | "needs_reconnect" | "unavailable";
};

export const inboxProviderLabel = (provider: LinkedInbox["provider"]) => provider === "gmail" ? "Gmail" : "Outlook";
