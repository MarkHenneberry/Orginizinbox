import "server-only";
import { runtimeConfig } from "@/lib/config";
import { legacyCleanupTtlMs, retentionDuration, scanStateTtlMs } from "@/lib/domain/transient-retention";

export function RetentionDisclosure() {
  return (
    <div className="muted mt-4 max-w-3xl leading-8">
      <h2 className="text-xl font-bold text-[var(--navy)]">Temporary encrypted storage</h2>
      <p>
        Your Inbox Report and the details needed to continue a scan or approved cleanup are stored
        temporarily in encrypted form in our database. Scan and report state expires after{" "}
        {retentionDuration(scanStateTtlMs / 1000)} without a saved update.
      </p>
      <p>
        Cleanup details normally have a {retentionDuration(runtimeConfig.cleanupStateActiveTtlSeconds)} active window.
        Where Undo is available, its configured window is {retentionDuration(runtimeConfig.cleanupStateUndoTtlSeconds)}.
        Final details without Undo expire after {retentionDuration(runtimeConfig.cleanupStateTerminalTtlSeconds)}.
        These windows can restart as cleanup progresses; the result shows your actual Undo deadline.
        {runtimeConfig.development ? <> Small development cleanups keep temporary state for {retentionDuration(legacyCleanupTtlMs / 1000)}.</> : null}
      </p>
      <p>
        Expired state is no longer available. A scheduled deletion runs every minute, removing
        expired data once any running task&apos;s ownership window ends. Service outages may delay deletion.
        Disconnect clears temporary state sooner, including the restoration details needed for Undo.
        Reconnecting cannot restore those details. Account records and summary cleanup receipts are
        separate from these temporary reports. Database backup retention is separate from this deletion schedule.
      </p>
    </div>
  );
}
