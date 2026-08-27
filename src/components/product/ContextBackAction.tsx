import Link from "next/link";

export function ContextBackAction({ href, label, className = "" }: { href: string; label: string; className?: string }) {
  return (
    <Link className={`context-back-action btn btn-secondary focus-ring ${className}`.trim()} href={href}>
      <span aria-hidden="true">&larr;</span>
      <span>{label}</span>
    </Link>
  );
}
