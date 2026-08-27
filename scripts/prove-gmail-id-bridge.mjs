import { createDecipheriv } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { ImapFlow } from "imapflow";
import {
  getGmailIdBridgeChecks,
  gmailImapDecimalIdToApiHex,
} from "../src/lib/providers/gmail/id-bridge.ts";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const requestedCount = parseRequestedCount(process.argv[2]);
const prisma = new PrismaClient();
let client;

const result = {
  messagesChecked: 0,
  xGmMsgidRetrieved: 0,
  apiIdMatched: 0,
  mismatch: 0,
  unavailable: 0,
  idCheckFailures: 0,
  senderCheckFailures: 0,
  systemLabelCheckFailures: 0,
  internalDateCheckFailures: 0
};

try {
  const connection = await prisma.providerConnection.findFirst({
    where: {
      provider: "gmail",
      disconnectedAt: null,
      encryptedAccessToken: { not: null },
      encryptedAccountEmail: { not: null }
    },
    orderBy: { updatedAt: "desc" }
  });

  if (!connection?.encryptedAccessToken || !connection.encryptedAccountEmail) {
    throw new Error("No active Gmail connection is available for the development proof.");
  }

  const accountEmail = decryptSecret(connection.encryptedAccountEmail);
  const accessToken = await getUsableAccessToken(connection);
  client = new ImapFlow({
    host: process.env.GMAIL_IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.GMAIL_IMAP_PORT || 993),
    secure: true,
    logger: false,
    disableAutoIdle: true,
    auth: { user: accountEmail, accessToken },
    tls: { rejectUnauthorized: true }
  });

  await client.connect();
  const hasGmailExtension = client.capabilities.has("X-GM-EXT-1");
  const hasObjectId = client.capabilities.has("OBJECTID");
  if (!hasGmailExtension || hasObjectId) {
    throw new Error("Explicit X-GM-MSGID provenance could not be established for this IMAP session.");
  }

  const mailboxes = await client.list();
  const allMail = mailboxes.find((mailbox) => mailbox.specialUse === "\\All" || mailbox.flags?.has("\\All"));
  if (!allMail) throw new Error("Gmail All Mail mailbox was not found.");
  const mailbox = await client.mailboxOpen(allMail.path, { readOnly: true });
  if (!mailbox.readOnly) throw new Error("Gmail All Mail did not open read-only.");

  const count = Math.min(requestedCount, mailbox.exists);
  if (count === 0) throw new Error("The Gmail mailbox has no messages available for the proof.");
  const range = `${mailbox.exists - count + 1}:${mailbox.exists}`;

  for await (const message of client.fetch(range, {
    uid: true,
    flags: true,
    labels: true,
    internalDate: true,
    headers: ["From"]
  }, { uid: false })) {
    result.messagesChecked += 1;
    if (!message.emailId) {
      result.unavailable += 1;
      continue;
    }
    result.xGmMsgidRetrieved += 1;

    let apiMessageId;
    try {
      apiMessageId = gmailImapDecimalIdToApiHex(message.emailId);
    } catch {
      result.mismatch += 1;
      continue;
    }

    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${apiMessageId}`);
    url.searchParams.set("format", "metadata");
    url.searchParams.set("metadataHeaders", "From");
    url.searchParams.set("fields", "id,labelIds,internalDate,payload(headers(name,value))");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      result.unavailable += 1;
      continue;
    }

    const apiMessage = await response.json();
    const apiSender = apiMessage.payload?.headers?.find((header) => header.name?.toLowerCase() === "from")?.value;
    const imapSender = parseHeader(message.headers, "From");
    const checks = getGmailIdBridgeChecks({
      imapMessageId: message.emailId,
      apiMessageId: apiMessage.id,
      imapSender,
      apiSender,
      imapInternalDateMs: message.internalDate instanceof Date ? message.internalDate.getTime() : undefined,
      apiInternalDateMs: parseInteger(apiMessage.internalDate),
      imapLabels: [...(message.labels || []), ...(message.flags || [])],
      apiLabelIds: apiMessage.labelIds || []
    });
    const matched =
      checks.apiIdMatches && checks.decimalRoundTripMatches && checks.senderMatches && checks.systemLabelsMatch;
    if (!checks.apiIdMatches || !checks.decimalRoundTripMatches) result.idCheckFailures += 1;
    if (!checks.senderMatches) result.senderCheckFailures += 1;
    if (!checks.systemLabelsMatch) result.systemLabelCheckFailures += 1;
    if (!checks.internalDateMatches) result.internalDateCheckFailures += 1;
    if (matched) result.apiIdMatched += 1;
    else result.mismatch += 1;
  }

  printResult(result, hasGmailExtension, hasObjectId);
  if (
    result.messagesChecked !== count ||
    result.xGmMsgidRetrieved !== count ||
    result.apiIdMatched !== count ||
    result.mismatch !== 0 ||
    result.unavailable !== 0
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  printResult(result, false, false);
  process.stderr.write(`Proof failed: ${error instanceof Error ? error.message : "Unknown development proof error."}\n`);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
  await prisma.$disconnect();
}

function parseRequestedCount(value) {
  if (value === undefined) return 10;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 10) {
    throw new Error("Proof sample size must be an integer from 5 through 10.");
  }
  return parsed;
}

function decryptSecret(serialized) {
  const rawKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!rawKey) throw new Error("TOKEN_ENCRYPTION_KEY is required.");
  const base64Key = Buffer.from(rawKey, "base64");
  const key = base64Key.length === 32 ? base64Key : Buffer.from(rawKey, "utf8");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must resolve to 32 bytes.");
  const payload = JSON.parse(Buffer.from(serialized, "base64url").toString("utf8"));
  if (payload.version !== 1) throw new Error("Unsupported encrypted secret version.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

async function getUsableAccessToken(connection) {
  if (!connection.tokenExpiresAt || connection.tokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decryptSecret(connection.encryptedAccessToken);
  }
  if (!connection.encryptedRefreshToken) throw new Error("The Gmail access token expired without a refresh token.");
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth client configuration is required to refresh the development proof token.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: decryptSecret(connection.encryptedRefreshToken),
      grant_type: "refresh_token"
    })
  });
  if (!response.ok) throw new Error(`Google token refresh failed with status ${response.status}.`);
  const tokens = await response.json();
  if (!tokens.access_token) throw new Error("Google token refresh returned no access token.");
  return tokens.access_token;
}

function parseHeader(headers, name) {
  if (!headers) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = headers.toString("utf8").match(new RegExp(`^${escaped}:\\s*(.+(?:\\r?\\n[\\t ].+)*)`, "im"));
  return match?.[1]?.replace(/\r?\n[\t ]+/g, " ").trim();
}

function parseInteger(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function printResult(summary, hasGmailExtension, hasObjectId) {
  process.stdout.write([
    "ORGANIZINBOX DEV GMAIL ID BRIDGE",
    `Gmail extension confirmed: ${hasGmailExtension ? "yes" : "no"}`,
    `OBJECTID absent: ${hasObjectId ? "no" : "yes"}`,
    `Messages checked: ${summary.messagesChecked}`,
    `X-GM-MSGID retrieved: ${summary.xGmMsgidRetrieved}`,
    `API ID matched: ${summary.apiIdMatched}`,
    `Mismatch: ${summary.mismatch}`,
    `Unavailable: ${summary.unavailable}`,
    `ID check failures: ${summary.idCheckFailures}`,
    `Sender check failures: ${summary.senderCheckFailures}`,
    `System-label check failures: ${summary.systemLabelCheckFailures}`,
    `Internal-date same-second differences (supplemental): ${summary.internalDateCheckFailures}`
  ].join("\n") + "\n");
}
