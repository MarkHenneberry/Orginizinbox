import "server-only";
import { getCurrentProviderConnection } from "@/lib/server/provider-connection-state";

export type AccountConnectionState =
  | {
      mode: "fixture";
      sourceLabel: "DEVELOPMENT FIXTURE";
      hasActiveReport: boolean;
    }
  | {
      mode: "connected";
      provider: "gmail";
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
      provider: "gmail",
      accountEmail: connection.accountEmail,
      status: "Connected",
      hasActiveReport
    };
  }

  return { mode: "none", hasActiveReport };
}
