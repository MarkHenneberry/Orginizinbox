"use client";

import { useState } from "react";

export function RemoveGoogleAuthorizationConfirmation() {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        className="focus-ring rounded-md px-1 py-2 text-sm font-bold text-[var(--teal-dark)] hover:underline"
        onClick={() => setConfirming(true)}
        type="button"
      >
        Remove Google authorization
      </button>
    );
  }

  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--soft)] p-4" role="group" aria-labelledby="remove-google-authorization-title">
      <h3 className="m-0 text-lg font-extrabold text-[var(--navy)]" id="remove-google-authorization-title">
        Remove Google authorization?
      </h3>
      <p className="muted mt-2 text-sm">
        This disconnects Gmail, clears your temporary Organizinbox data, and asks Google to remove Organizinbox from your connected apps.
      </p>
      <p className="muted mt-2 text-sm">
        If you reconnect immediately, Google may take a short time to finish removing the previous authorization.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button className="btn btn-secondary focus-ring" onClick={() => setConfirming(false)} type="button">
          Cancel
        </button>
        <form action="/api/app/remove-google-authorization" method="post">
          <button className="btn btn-primary focus-ring" type="submit">
            Remove authorization
          </button>
        </form>
      </div>
    </div>
  );
}
