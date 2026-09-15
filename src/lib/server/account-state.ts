import "server-only";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";

export type AccountConnectionState =
  | { mode: "unavailable"; provider?: "gmail" | "microsoft"; hasActiveReport: boolean }
  | {
      mode: "fixture";
      sourceLabel: "DEVELOPMENT FIXTURE";
      hasActiveReport: boolean;
    }
  | {
      mode: "connected";
      provider: "gmail" | "microsoft";
      accountEmail?: string;
      status: "Connected";
      hasActiveReport: boolean;
    }
  | {
      mode: "none";
      hasActiveReport: boolean;
    };

export async function getAccountConnectionState(hasActiveReport: boolean): Promise<AccountConnectionState> {
  const connection = await getCurrentProviderConnection();
  if (connection.mode === "unavailable") return { mode: "unavailable", provider: connection.provider, hasActiveReport: false };
  if (connection.mode === "fixture") {
    return {
      mode: "fixture",
      sourceLabel: "DEVELOPMENT FIXTURE",
      hasActiveReport
    };
  }

  if (connection.mode === "connected") {
    return {
      mode: "connected",
      provider: connection.provider,
      accountEmail: connection.accountEmail,
      status: "Connected",
      hasActiveReport
    };
  }

  return { mode: "none", hasActiveReport };
}
