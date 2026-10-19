export const outlookVerificationTimingHeader = "X-Outlook-Verification-Id";
const bounded = (value: number) => Math.max(0, Math.min(30 * 60_000, Math.round(value)));

// Local monotonic durations only. Server checkpoint age is an explicitly labelled upper bound.
export function createOutlookVerificationClientTiming(now = () => performance.now()) {
  const started = now();
  let correlationId: string | null = null;
  let acceptedAt = started, startRequestMs = 0, pollRequests = 0, pollHttpMs = 0;
  let readyAt: number | undefined, checkpointAgeMs: number | undefined, lastPollMs = 0, sent = false;
  return {
    hasTrace: () => Boolean(correlationId),
    headers: (): Record<string, string> => correlationId ? { [outlookVerificationTimingHeader]: correlationId } : {},
    response(response: Response, requestStarted: number, status: string | undefined, initial = false) {
      const received = now();
      if (initial) {
        correlationId = response.headers.get(outlookVerificationTimingHeader);
        startRequestMs = received - started; acceptedAt = received;
      } else {
        pollRequests++; lastPollMs = received - requestStarted; pollHttpMs += lastPollMs;
      }
      if (status === "ready" && readyAt === undefined) {
        readyAt = received;
        const age = response.headers.get("X-Outlook-Ready-Checkpoint-Age-Ms");
        if (age !== null && Number.isFinite(Number(age))) checkpointAgeMs = Number(age);
      }
    },
    visible() {
      if (sent || !correlationId || readyAt === undefined) return;
      sent = true;
      const renderAfterReadyResponseMs = now() - readyAt;
      return {
        correlationId, clientTotalMs: bounded(now() - started), startRequestMs: bounded(startRequestMs),
        pollRequests, pollHttpMs: bounded(pollHttpMs),
        pollingAndWaitMs: bounded(readyAt - acceptedAt - pollHttpMs),
        renderAfterReadyResponseMs: bounded(renderAfterReadyResponseMs),
        ...(checkpointAgeMs === undefined ? {} : {
          readyCheckpointToVisibleUpperBoundMs: bounded(checkpointAgeMs + lastPollMs + renderAfterReadyResponseMs)
        })
      };
    }
  };
}
