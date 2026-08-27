const gmailMessageIdMax = (1n << 64n) - 1n;

export type GmailIdBridgeEvidence = {
  imapMessageId: string;
  apiMessageId: string;
  imapSender: string | undefined;
  apiSender: string | undefined;
  imapInternalDateMs: number | undefined;
  apiInternalDateMs: number | undefined;
  imapLabels: readonly string[];
  apiLabelIds: readonly string[];
};

export type GmailIdBridgeChecks = {
  apiIdMatches: boolean;
  decimalRoundTripMatches: boolean;
  senderMatches: boolean;
  systemLabelsMatch: boolean;
  internalDateMatches: boolean;
};

export function gmailImapDecimalIdToApiHex(value: string): string {
  const parsed = parseUnsigned64Bit(value, /^\d+$/, "X-GM-MSGID");
  return parsed.toString(16);
}

export function gmailApiHexIdToImapDecimal(value: string): string {
  const normalized = value.toLowerCase();
  const parsed = parseUnsigned64Bit(normalized, /^[0-9a-f]+$/, "Gmail API message ID", 16);
  return parsed.toString(10);
}

export function verifyGmailIdBridge(evidence: GmailIdBridgeEvidence): boolean {
  const checks = getGmailIdBridgeChecks(evidence);
  return checks.apiIdMatches && checks.decimalRoundTripMatches && checks.senderMatches && checks.systemLabelsMatch;
}

export function getGmailIdBridgeChecks(evidence: GmailIdBridgeEvidence): GmailIdBridgeChecks {
  const derivedApiId = gmailImapDecimalIdToApiHex(evidence.imapMessageId);
  const roundTrippedImapId = gmailApiHexIdToImapDecimal(evidence.apiMessageId);
  const imapSender = normalizeSender(evidence.imapSender);
  const apiSender = normalizeSender(evidence.apiSender);

  return {
    apiIdMatches: derivedApiId === evidence.apiMessageId.toLowerCase(),
    decimalRoundTripMatches: roundTrippedImapId === normalizeDecimalId(evidence.imapMessageId),
    senderMatches: imapSender !== undefined && imapSender === apiSender,
    systemLabelsMatch: equalSets(normalizeImapSystemLabels(evidence.imapLabels), normalizeApiSystemLabels(evidence.apiLabelIds)),
    internalDateMatches:
      evidence.imapInternalDateMs !== undefined &&
      evidence.apiInternalDateMs !== undefined &&
      Math.floor(evidence.imapInternalDateMs / 1000) === Math.floor(evidence.apiInternalDateMs / 1000)
  };
}

const gmailSystemLabels = new Map([
  ["\\inbox", "INBOX"],
  ["\\sent", "SENT"],
  ["\\draft", "DRAFT"],
  ["\\trash", "TRASH"],
  ["\\spam", "SPAM"],
  ["\\important", "IMPORTANT"],
  ["\\starred", "STARRED"],
  ["\\flagged", "STARRED"]
]);

function normalizeImapSystemLabels(labels: readonly string[]): Set<string> {
  return new Set(labels.map((label) => gmailSystemLabels.get(label.toLowerCase())).filter((label): label is string => Boolean(label)));
}

function normalizeApiSystemLabels(labels: readonly string[]): Set<string> {
  return new Set(labels.filter((label) => gmailSystemLabels.has(`\\${label.toLowerCase()}`)));
}

function equalSets(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function normalizeDecimalId(value: string): string {
  return BigInt(value).toString(10);
}

function normalizeSender(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const unfolded = value.replace(/\r?\n[\t ]+/g, " ").trim().toLowerCase();
  return unfolded.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/)?.[0];
}

function parseUnsigned64Bit(value: string, format: RegExp, label: string, radix = 10): bigint {
  if (!format.test(value)) {
    throw new Error(`${label} has an invalid format.`);
  }

  const parsed = radix === 16 ? BigInt(`0x${value}`) : BigInt(value);
  if (parsed < 0n || parsed > gmailMessageIdMax) {
    throw new Error(`${label} is outside the unsigned 64-bit range.`);
  }
  return parsed;
}
