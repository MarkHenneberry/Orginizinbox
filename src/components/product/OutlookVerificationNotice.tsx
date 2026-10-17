"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { startAdaptivePolling } from "@/lib/adaptive-polling";
import type { OutlookVerification } from "@/lib/domain/outlook-progressive";

export function OutlookVerificationNotice({ verification }: { verification: OutlookVerification }) {
  const router = useRouter();
  const current = verification;
  const lastChecked = useRef(verification.checked);
  useEffect(() => {
    if (verification.status !== "running") return;
    return startAdaptivePolling(async signal => {
      const response = await fetch("/api/app/microsoft-scan/status", { cache: "no-store", signal });
      if (!response.ok) throw new Error("Status unavailable");
      const result = await response.json() as { progress?: { outlookVerification?: OutlookVerification }; reportStale?: boolean };
      if (signal.aborted) return false;
      if (result.progress?.outlookVerification?.checked !== lastChecked.current || result.progress.outlookVerification.status !== "running" || result.reportStale) {
        lastChecked.current = result.progress?.outlookVerification?.checked ?? lastChecked.current;
        router.refresh();
      }
      return result.progress?.outlookVerification?.status === "running" && !result.reportStale;
    }, () => undefined, 5_000);
  }, [router, verification.status]);
  if (current.status === "complete") return current.failed ? <p className="muted text-sm">Some messages could not be verified and remain in Review.</p> : null;
  return <section className="mb-6 border border-[var(--line)] rounded-md p-4" role="status" aria-live="polite">
    <p className="m-0 font-bold">{current.status === "running" ? "Your report is ready. We're still verifying cleanup suggestions in the background." : "Your report is ready. Some cleanup suggestions could not be verified."}</p>
    <p className="muted mb-0 text-sm">{current.checked.toLocaleString()} / {current.candidates.toLocaleString()} candidates checked. Only verified Suggested messages are available for cleanup. Messages awaiting verification remain in Review.</p>
  </section>;
}
