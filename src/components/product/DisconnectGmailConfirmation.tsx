"use client";

import { useState } from "react";

export function DisconnectGmailConfirmation() {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button className="btn btn-secondary focus-ring" onClick={() => setConfirming(true)} type="button">
        Disconnect Gmail
      </button>
    );
  }

  return (
    <div className="w-full rounded-md border border-[var(--line)] bg-[var(--soft)] p-4" role="group" aria-labelledby="disconnect-gmail-title">
      <h3 className="m-0 text-lg font-extrabold text-[var(--navy)]" id="disconnect-gmail-title">
        Disconnect Gmail?
      </h3>
      <p className="muted mt-2 text-sm">This removes Organizinbox&apos;s saved Gmail access and clears your temporary Inbox Report.</p>
      <p className="muted mt-2 text-sm">You can reconnect anytime.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button className="btn btn-secondary focus-ring" onClick={() => setConfirming(false)} type="button">
          Cancel
        </button>
        <form action="/api/app/disconnect" method="post">
          <button className="btn btn-primary focus-ring" type="submit">
            Disconnect Gmail
          </button>
        </form>
      </div>
    </div>
  );
}
