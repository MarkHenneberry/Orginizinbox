import Link from "next/link";
import { cleanupAccessCopy, type CleanupUiAccess } from "@/lib/domain/cleanup-ui";

export function CleanupAccessNotice({ access }: { access: CleanupUiAccess }) {
  if (access === "available") return null;
  const copy = cleanupAccessCopy[access];
  return <div className="my-4" role="status">
    <p className="muted">{copy.text}</p>
    {copy.action && copy.href ? <Link className="btn btn-secondary focus-ring" href={copy.href}>{copy.action}</Link> : null}
  </div>;
}
