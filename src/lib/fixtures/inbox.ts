import { StreamingReportAggregator } from "@/lib/domain/streaming-aggregator";
import type { InboxReport, NormalizedMessageMetadata, ProviderCategory } from "@/lib/domain/types";

const fixtureNow = new Date("2026-08-25T12:00:00Z");
const participatedConversationId = "fixture-participated-conversation";
const fixtureParticipatedConversationIds = new Set([participatedConversationId]);

type FixtureScenario = {
  displayName: string;
  address: string;
  count: number;
  providerCategory?: ProviderCategory;
  listHeaders?: boolean;
  autoSubmitted?: boolean;
  userLabel?: boolean;
  unreadRate: number;
  oldRate: number;
  protectedRate?: number;
};

const scenarios: FixtureScenario[] = [
  { displayName: "Daily Brief", address: "digest@dailybrief.example", count: 1200, listHeaders: true, unreadRate: 0.91, oldRate: 0.88 },
  { displayName: "River Cart", address: "deals@rivercart.example", count: 900, providerCategory: "promotions", listHeaders: true, unreadRate: 0.82, oldRate: 0.74 },
  { displayName: "Social Circle", address: "notify@socialcircle.example", count: 700, providerCategory: "social", unreadRate: 0.94, oldRate: 0.81 },
  { displayName: "Account Updates", address: "updates@account.example", count: 500, providerCategory: "updates", autoSubmitted: true, userLabel: true, unreadRate: 0.45, oldRate: 0.62 },
  { displayName: "Avery Morgan", address: "avery@example.test", count: 300, providerCategory: "personal", unreadRate: 0.08, oldRate: 0.35 },
  { displayName: "Mixed List", address: "news@mixed-list.example", count: 1000, listHeaders: true, unreadRate: 0.76, oldRate: 0.79, protectedRate: 0.2 },
  { displayName: "Unknown Archive", address: "hello@unknown-archive.example", count: 1400, unreadRate: 0.97, oldRate: 0.96 }
];

export function getFixtureInboxReport(): InboxReport {
  const aggregator = new StreamingReportAggregator({
    now: fixtureNow,
    participatedConversationIds: fixtureParticipatedConversationIds
  });
  let batch: NormalizedMessageMetadata[] = [];

  for (const message of generateFixtureMessageStream()) {
    batch.push(message);
    if (batch.length === 500) {
      aggregator.processBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) aggregator.processBatch(batch);

  return aggregator.snapshot("gmail", true);
}

export function generateFixtureMessages(): NormalizedMessageMetadata[] {
  return [...generateFixtureMessageStream()];
}

export function* generateFixtureMessageStream(): Generator<NormalizedMessageMetadata> {
  yield buildSentParticipationMessage();
  for (const scenario of scenarios) {
    for (let index = 0; index < scenario.count; index += 1) {
      yield buildMessage(scenario, index);
    }
  }

  const seededCount = scenarios.reduce((total, scenario) => total + scenario.count, 1);
  const remaining = 38217 - seededCount;
  for (let index = 0; index < remaining; index += 1) {
    const kind = index % 6;
    const senderNumber = Math.floor(index / 125) + 1;
    const scenario: FixtureScenario =
      kind === 0
        ? { displayName: `Bulk List ${senderNumber}`, address: `bulk-${senderNumber}@fixture-mail.example`, count: remaining, listHeaders: true, unreadRate: 0.84, oldRate: 0.76 }
        : kind === 1
          ? { displayName: `Promotion ${senderNumber}`, address: `promo-${senderNumber}@fixture-mail.example`, count: remaining, providerCategory: "promotions", unreadRate: 0.8, oldRate: 0.69 }
          : kind === 2
            ? { displayName: `Social ${senderNumber}`, address: `social-${senderNumber}@fixture-mail.example`, count: remaining, providerCategory: "social", unreadRate: 0.88, oldRate: 0.7 }
            : kind === 3
              ? { displayName: `Account ${senderNumber}`, address: `account-${senderNumber}@fixture-mail.example`, count: remaining, providerCategory: "updates", userLabel: true, unreadRate: 0.35, oldRate: 0.58 }
              : kind === 4
                ? { displayName: `Personal ${senderNumber}`, address: `person-${senderNumber}@fixture-mail.example`, count: remaining, providerCategory: "personal", unreadRate: 0.12, oldRate: 0.42 }
                : { displayName: `Unknown ${senderNumber}`, address: `unknown-${senderNumber}@fixture-mail.example`, count: remaining, unreadRate: 0.9, oldRate: 0.9 };
    yield buildMessage(scenario, index);
  }
}

function buildMessage(scenario: FixtureScenario, index: number): NormalizedMessageMetadata {
  const old = ratioHit(index, scenario.oldRate);
  const protectedHit = ratioHit(index + 7, scenario.protectedRate ?? 0);
  const recent = protectedHit && index % 3 === 0;
  const receivedAt = recent ? daysAgo(10 + (index % 18)) : old ? daysAgo(190 + (index % 1400)) : daysAgo(45 + (index % 120));
  const domain = scenario.address.split("@")[1];

  return {
    providerMessageId: `fixture-${scenario.address}-${index}`,
    provider: "gmail",
    senderAddress: scenario.address,
    senderDisplayName: scenario.displayName,
    senderDomain: domain,
    receivedAt,
    isRead: !ratioHit(index, scenario.unreadRate),
    estimatedSize: 52000 + (index % 17) * 1600,
    providerLabels: scenario.providerCategory ? [`CATEGORY_${scenario.providerCategory.toUpperCase()}`] : [],
    userLabels: scenario.userLabel ? ["Saved"] : [],
    providerCategory: scenario.providerCategory,
    hasListUnsubscribe: scenario.listHeaders,
    listId: scenario.listHeaders ? `${domain}.list` : undefined,
    autoSubmitted: scenario.autoSubmitted ? "auto-generated" : undefined,
    precedence: scenario.listHeaders ? "list" : undefined,
    isStarred: protectedHit && index % 3 === 1,
    isImportant: protectedHit && index % 3 === 2,
    conversationId: scenario.displayName === "Mixed List" && index === 5 ? participatedConversationId : `fixture-conversation-${scenario.address}-${index}`
  };
}

function buildSentParticipationMessage(): NormalizedMessageMetadata {
  return {
    providerMessageId: "fixture-sent-participation",
    provider: "gmail",
    senderAddress: "me@example.test",
    senderDisplayName: "Me",
    senderDomain: "example.test",
    receivedAt: daysAgo(400),
    isRead: true,
    estimatedSize: 1200,
    providerLabels: ["SENT"],
    isSent: true,
    conversationId: participatedConversationId
  };
}

function ratioHit(index: number, rate: number): boolean {
  return (index % 1000) / 1000 < rate;
}

function daysAgo(days: number): Date {
  return new Date(fixtureNow.getTime() - days * 24 * 60 * 60 * 1000);
}
