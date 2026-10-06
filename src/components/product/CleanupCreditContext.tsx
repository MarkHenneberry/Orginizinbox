import Link from "next/link";

export function CleanupCreditContext({ available, requested, reserved = false }: { available: number | null; requested: number; reserved?: boolean }) {
  const insufficient = !reserved && available !== null && requested > available;
  return <div className="cleanup-credit-context" aria-live="polite">
    <dl><div><dt>Selected to check</dt><dd>{requested.toLocaleString("en-US")} emails</dd></div>
      <div><dt>Available credits</dt><dd>{available === null ? "Unavailable" : available.toLocaleString("en-US")}</dd></div></dl>
    {reserved ? <p>Credits for this job are handled by its existing reservation. Only verified moves spend credits.</p>
      : insufficient ? <><p>You need {requested.toLocaleString("en-US")} credits for this selection. Choose fewer messages or buy credits.</p><Link className="btn btn-secondary focus-ring" href="/app/credits">Buy credits</Link></>
      : <p>Your balance is checked again before cleanup. Only verified moves spend credits.</p>}
  </div>;
}
