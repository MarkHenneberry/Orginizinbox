"use client";

import { useEffect, useRef, useState } from "react";

export function OperationStatus({
  title,
  description,
  startedAt
}: {
  title: string;
  description: string;
  startedAt?: number;
}) {
  const fallbackStartedAt = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const updateElapsed = () => {
      fallbackStartedAt.current ??= Date.now();
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - (startedAt ?? fallbackStartedAt.current)) / 1000))
      );
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="mt-4 border-l-4 border-[var(--teal)] bg-emerald-50 px-4 py-3"
      role="status"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-[var(--teal)] border-t-transparent motion-safe:animate-spin motion-reduce:animate-none"
        />
        <div>
          <p className="m-0 font-extrabold text-[var(--navy)]">{title}</p>
          <p className="muted m-0 mt-1 text-sm">{description}</p>
          <p className="muted m-0 mt-2 text-xs">Elapsed: {elapsedSeconds}s</p>
        </div>
      </div>
    </div>
  );
}
