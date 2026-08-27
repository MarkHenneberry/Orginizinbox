export type GmailSystemLabel = "STARRED" | "IMPORTANT" | "SENT" | "DRAFT";
export type GmailCategoryLabel = "PROMOTIONS" | "SOCIAL" | "PERSONAL" | "UPDATES";

const systemLabelAliases = new Map<string, string>([
  ["ALL_MAIL", "ALL"],
  ["DRAFTS", "DRAFT"],
  ["SENT_MAIL", "SENT"]
]);

const knownSystemLabels = new Set([
  "ALL",
  "DRAFT",
  "FLAGGED",
  "IMPORTANT",
  "INBOX",
  "JUNK",
  "SENT",
  "SPAM",
  "STARRED",
  "TRASH"
]);

const categoryLabels = new Map<string, GmailCategoryLabel>([
  ["CATEGORY_PROMOTIONS", "PROMOTIONS"],
  ["CATEGORY_SOCIAL", "SOCIAL"],
  ["CATEGORY_PERSONAL", "PERSONAL"],
  ["CATEGORY_PRIMARY", "PERSONAL"],
  ["CATEGORY_UPDATES", "UPDATES"]
]);

export type GmailLabelAnalysis = {
  hasAnyLabels: boolean;
  systemLabels: Set<GmailSystemLabel>;
  categoryLabels: Set<GmailCategoryLabel>;
  userLabels: string[];
  unrecognizedSystemOrCategoryShapedLabels: number;
};

export function analyzeGmailLabels(labels: readonly string[]): GmailLabelAnalysis {
  const systemLabels = new Set<GmailSystemLabel>();
  const observedCategoryLabels = new Set<GmailCategoryLabel>();
  const userLabels: string[] = [];
  let unrecognizedSystemOrCategoryShapedLabels = 0;

  for (const label of labels) {
    const normalized = normalizeGmailLabel(label);
    if (!normalized) continue;

    if (isDiagnosticSystemLabel(normalized)) systemLabels.add(normalized);
    if (categoryLabels.has(normalized)) observedCategoryLabels.add(categoryLabels.get(normalized)!);

    if (knownSystemLabels.has(normalized) || categoryLabels.has(normalized)) continue;
    if (isSystemOrCategoryShaped(label, normalized)) {
      unrecognizedSystemOrCategoryShapedLabels += 1;
      continue;
    }
    userLabels.push(label);
  }

  return {
    hasAnyLabels: labels.length > 0,
    systemLabels,
    categoryLabels: observedCategoryLabels,
    userLabels,
    unrecognizedSystemOrCategoryShapedLabels
  };
}

export function normalizeGmailLabel(label: string): string {
  const normalized = label
    .trim()
    .replace(/^\\+/, "")
    .replace(/^\[(?:gmail|googlemail)\][\\/]/i, "")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
  return systemLabelAliases.get(normalized) ?? normalized;
}

function isDiagnosticSystemLabel(label: string): label is GmailSystemLabel {
  return label === "STARRED" || label === "IMPORTANT" || label === "SENT" || label === "DRAFT";
}

function isSystemOrCategoryShaped(rawLabel: string, normalizedLabel: string) {
  return /^\\/.test(rawLabel.trim()) || /^\[(?:gmail|googlemail)\][\\/]/i.test(rawLabel.trim()) || normalizedLabel.startsWith("CATEGORY_");
}
