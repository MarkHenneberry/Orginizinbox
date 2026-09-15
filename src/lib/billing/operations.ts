import "server-only";

const events = {
  checkout_failed: true,
  webhook_signature_failed: true,
  webhook_processing_failed: true,
  reconciliation_required: true,
  reconciliation_failed: true,
  reconciliation_succeeded: true,
  entitlement_denied: true
} as const;

// No dynamic context or raw exceptions are accepted by this logging boundary.
export function billingOperation(event: keyof typeof events) {
  if (!Object.hasOwn(events, event)) return;
  console.warn(JSON.stringify({ component: "billing", event }));
}
