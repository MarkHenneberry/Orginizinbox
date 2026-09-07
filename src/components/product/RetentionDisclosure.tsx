import "server-only";
import { runtimeConfig } from "@/lib/config";
import { legacyCleanupTtlMs, retentionDuration, scanStateTtlMs } from "@/lib/domain/transient-retention";

export function RetentionDisclosure() {
  return (
    <div className="muted mt-4 max-w-3xl leading-8">
      <h2 className="text-xl font-bold text-[var(--navy)]">Temporary encrypted storage</h2>
      <p>
        Your Inbox Report and the state needed to resume a scan or approved cleanup are stored
        temporarily in encrypted form in our database. Scan and report state expires after{" "}
        {retentionDuration(scanStateTtlMs / 1000)} without a saved update.
      </p>
      <p>
        Cleanup state uses a {retentionDuration(runtimeConfig.cleanupStateActiveTtlSeconds)} active window,
        a {retentionDuration(runtimeConfig.cleanupStateUndoTtlSeconds)} Undo window, and a{" "}
        {retentionDuration(runtimeConfig.cleanupStateTerminalTtlSeconds)} final-state window.
        These windows can restart as the job progresses. The legacy small-cleanup development path
        keeps temporary state for {retentionDuration(legacyCleanupTtlMs / 1000)}.
      </p>
      <p>
        Expired state is no longer available. A scheduled deletion runs every minute, removing
        expired data once any in-flight worker lease ends. Service outages may delay deletion.
        Disconnect clears temporary state sooner. Account records and aggregate job receipts are
        separate from these temporary reports. Database backup retention is separate from this deletion schedule.
      </p>
    </div>
  );
}
