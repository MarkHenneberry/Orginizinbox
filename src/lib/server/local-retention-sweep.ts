import "server-only";
import { transientPurgeIntervalMs } from "@/lib/domain/transient-retention";

// Development adapters only. Durable production state is swept by database Cron.
export function createLocalRetentionSweep(sweep: () => boolean) {
  let timer: ReturnType<typeof setInterval> | undefined;
  return () => {
    if (timer) return;
    timer = setInterval(() => {
      if (!sweep()) {
        clearInterval(timer);
        timer = undefined;
      }
    }, transientPurgeIntervalMs);
    timer.unref();
  };
}
