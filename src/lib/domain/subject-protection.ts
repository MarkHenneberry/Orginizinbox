import libmime from "libmime";
import type { SubjectProtection } from "./types";

const maxSubjectLength = 4096;

const transactionalPatterns = [
  /\breceipts?\b/u,
  /\binvoices?\b/u,
  /\bpayment (?:confirmation|confirmed|due|processed|receipt|received|successful)\b/u,
  /\b(?:account|bank|billing|credit card|monthly) statements?\b/u,
  /\b(?:order|purchase|renewal|subscription|delivery|shipping) confirmation\b/u,
  /\b(?:booking|reservation) (?:confirmation|confirmed|details)\b/u,
  /\brefund (?:confirmation|confirmed|issued|processed)\b/u,
  /\btax (?:document|form|invoice|receipt|statement)\b/u,
  /\b(?:event|flight|support|train|travel|your) tickets?\b/u
] as const;

const securityAccountPatterns = [
  /\bsecurity (?:alert|notice|notification|warning)\b/u,
  /\bverification(?: code)?\b/u,
  /\bverify your (?:account|email|identity)\b/u,
  /\bpassword(?: change| changed| expired| recovery| reset)?\b/u,
  /\baccount (?:was )?(?:disabled|locked|suspended)\b/u,
  /\b(?:login|sign[ -]?in) alert\b/u,
  /\btwo[ -]?factor\b/u,
  /\b2fa\b/u,
  /\bone[ -]?time (?:code|password)\b/u,
  /\botp\b/u,
  /\brecovery code\b/u
] as const;

export function deriveSubjectProtection(rawSubject: string | undefined): SubjectProtection | undefined {
  const normalized = decodeAndNormalizeSubject(rawSubject);
  if (!normalized) return undefined;
  if (securityAccountPatterns.some((pattern) => pattern.test(normalized))) return "security_account";
  if (transactionalPatterns.some((pattern) => pattern.test(normalized))) return "transactional";
  return undefined;
}

export function decodeAndNormalizeSubject(rawSubject: string | undefined): string | undefined {
  if (!rawSubject || rawSubject.length > maxSubjectLength) return undefined;
  try {
    const decoded = libmime.decodeWords(rawSubject);
    if (!decoded || decoded.includes("=?")) return undefined;
    return decoded.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}
