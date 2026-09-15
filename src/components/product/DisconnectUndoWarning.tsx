export function DisconnectUndoWarning() {
  return <p className="mt-3 text-sm font-bold text-[var(--navy)]">If Undo or Recovery Undo is still available, use it before disconnecting. Disconnect removes the temporary restoration state, so reconnecting will not bring Undo back. It does not restore messages already moved.</p>;
}
