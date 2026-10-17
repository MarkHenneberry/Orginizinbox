import type { InboxReport } from "./types";

type Snapshot = { report?: InboxReport; progress: { status: string; provider: string; reportUsableMs?: number } };
export function isLiveReportUsable<T extends Snapshot>(session: T | undefined | null): session is T & { report: InboxReport } {
  return Boolean(session?.report && (session.progress.status === "completed" ||
    (session.progress.provider === "microsoft" && session.progress.reportUsableMs !== undefined && session.progress.status === "running")));
}
