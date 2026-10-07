import "server-only";
import { cache } from "react";
import { purgeExpiredUserTransientState } from "@/lib/server/transient-state-purge";

// Dedupe header, Account and Credits reads within one render, not across users/requests.
export const purgeUserTransientStateForActivity = cache(purgeExpiredUserTransientState);
