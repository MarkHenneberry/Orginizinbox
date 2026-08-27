import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  gmailCleanupJobs,
  invalidateGmailCleanupPreview,
  runOrJoinGmailCleanupOperation,
  type GmailCleanupJob
} from "@/lib/server/gmail-cleanup-store";

const createdJobIds: string[] = [];

afterEach(() => {
  for (const jobId of createdJobIds.splice(0)) gmailCleanupJobs.delete(jobId);
});

function seedJob(status: GmailCleanupJob["status"] = "ready", mutationStarted = false) {
  const id = `staged-flow-${crypto.randomUUID()}`;
  const userId = `user-${crypto.randomUUID()}`;
  gmailCleanupJobs.set(id, {
    id,
    userId,
    status,
    mutationStarted,
    expiresAt: Date.now() + 60_000
  } as GmailCleanupJob);
  createdJobIds.push(id);
  return { id, userId };
}

describe("cleanup stage UI contracts", () => {
  const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
  const selectStage = client.slice(
    client.indexOf("{!reviewStarted ? (\n          <>"),
    client.indexOf(") : job ? (")
  );
  const reviewStage = client.slice(client.indexOf(") : job ? ("), client.indexOf("function recommendationLabel"));
  const frozenContext = client.slice(
    client.indexOf("function FrozenSenderContext"),
    client.indexOf("function recommendationLabel")
  );

  it("starts in SELECT and transitions successful checks to a frozen REVIEW", () => {
    expect(client).toMatch(/useState\(false\)[\s\S]+reviewStarted/);
    expect(client).toMatch(/!benchmarkOnly && body\.job\.status === "ready"[\s\S]+setReviewStarted\(true\)/);
    expect(client).toMatch(/!reviewStarted \? <div className="panel overflow-hidden">/);
    expect(reviewStage).toContain("Ready to clean");
    expect(reviewStage).toContain('aria-live="polite"');
    expect(reviewStage).toContain("reviewHeadingRef");
  });

  it("keeps editable controls and the benchmark only in SELECT", () => {
    expect(selectStage).toContain("Check messages");
    expect(selectStage).toContain("cleanup-count");
    expect(selectStage).toContain("Run safety benchmark");
    expect(client).toMatch(/!reviewStarted \? <div[\s\S]+id="cleanup-search"[\s\S]+type="checkbox"[\s\S]+<\/div> : null/);
    expect(reviewStage).not.toContain('id="cleanup-search"');
    expect(reviewStage).not.toContain('id="cleanup-sort"');
    expect(reviewStage).not.toContain('type="checkbox"');
    expect(reviewStage).not.toContain("Run safety benchmark");
    expect(reviewStage).not.toContain('id="cleanup-count"');
  });

  it("shows read-only REVIEW actions and keeps Cancel in the same snapshot", () => {
    expect(reviewStage).toContain("Messages rechecked");
    expect(reviewStage).toContain("Sender groups contributing");
    expect(reviewStage).toContain("Protected and Review messages were left alone.");
    expect(reviewStage).toContain("Move {job.resolvedCount.toLocaleString()} to Trash");
    expect(reviewStage).toContain("Start over");
    expect(reviewStage).toMatch(/>Cancel<\/button>/);
    expect(reviewStage).toMatch(/onClick=\{\(\) => setFinalStep\(false\)\}/);
    expect(reviewStage).not.toMatch(/onClick=\{\(\) => resolvePreview/);
  });

  it("keeps the exact checked sender groups as semantic read-only REVIEW context", () => {
    expect(client).toMatch(/const groupIndices = \[\.\.\.selectedGroupIndices\]/);
    expect(client).toMatch(/body\.job\.status === "ready"[\s\S]+setCheckedGroupIndices\(groupIndices\)/);
    expect(client).toMatch(/groups\.filter\(\(group\) => checkedGroupIndexSet\.has\(group\.index\)\)/);
    expect(reviewStage).toContain("FrozenSenderContext groups={checkedGroups} job={job}");
    expect(frozenContext).toContain('aria-label="Checked sender groups"');
    expect(frozenContext).toContain("group.displayName");
    expect(frozenContext).toContain("recommendationLabel(group)");
    expect(frozenContext).not.toContain('type="checkbox"');
    expect(frozenContext).not.toContain("disabled=");
    expect(frozenContext).not.toContain("cleanup-search");
    expect(frozenContext).not.toContain("cleanup-sort");
    expect(frozenContext).not.toContain("Run safety benchmark");
  });

  it("keeps frozen desktop context bounded beside a sticky REVIEW summary", () => {
    expect(client).toMatch(/showFrozenReviewContext[\s\S]+lg:grid-cols-\[minmax\(0,1\.35fr\)_minmax\(320px,0\.65fr\)\]/);
    expect(client).toMatch(/showFrozenReviewContext \? "order-1 lg:order-2 lg:sticky lg:top-24"/);
    expect(frozenContext).toContain('className="order-2 lg:order-1"');
    expect(frozenContext).toContain("lg:max-h-[calc(100vh-18rem)]");
    expect(frozenContext).toContain("lg:min-h-[360px]");
    expect(frozenContext).toContain("lg:overflow-y-auto");
    expect(frozenContext).toContain("job.selectedSenderGroupCount");
    expect(frozenContext).toContain("job.selectedReadyCount");
    expect(frozenContext).toContain("job.contributingSenderGroupCount");
  });

  it("keeps summary and actions ahead of collapsed sender context on mobile", () => {
    expect(client.indexOf("<aside className={`panel p-5")).toBeLessThan(
      client.indexOf("<FrozenSenderContext groups={checkedGroups} job={job}")
    );
    expect(frozenContext).toContain('className="panel overflow-hidden lg:hidden"');
    expect(frozenContext).toMatch(/<details[\s\S]+<summary[\s\S]+Checked sender groups/);
    expect(frozenContext).toContain('className="panel hidden overflow-hidden lg:block"');
  });

  it("preserves working and completed states without restoring Check controls", () => {
    expect(client).toContain("We're rechecking them against Gmail before anything is moved.");
    expect(client).toContain("Moving ");
    expect(client).toContain("Messages moved. Verifying cleanup...");
    expect(reviewStage).toContain("CompletedResult");
    expect(reviewStage).toContain("UndoResult");
    expect(client).toContain("Rescan inbox");
    expect(reviewStage).not.toContain("Check ${requestedCount");
  });
});

describe("cleanup snapshot invalidation", () => {
  it("deletes a pre-mutation snapshot so the old job cannot be confirmed", () => {
    const job = seedJob();

    expect(invalidateGmailCleanupPreview(job.userId, job.id)).toBe("invalidated");
    expect(gmailCleanupJobs.has(job.id)).toBe(false);
  });

  it("is idempotent for an already missing or expired snapshot", () => {
    const job = seedJob();
    gmailCleanupJobs.delete(job.id);

    expect(invalidateGmailCleanupPreview(job.userId, job.id)).toBe("missing");
    expect(gmailCleanupJobs.has(job.id)).toBe(false);
  });

  it("refuses Start over after mutation starts or while Trash is claimed", async () => {
    const mutated = seedJob("running", true);
    expect(invalidateGmailCleanupPreview(mutated.userId, mutated.id)).toBe("mutation_started");
    expect(gmailCleanupJobs.has(mutated.id)).toBe(true);

    const claimed = seedJob();
    let release: (() => void) | undefined;
    const operation = runOrJoinGmailCleanupOperation(
      `trash:${claimed.id}`,
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    await Promise.resolve();

    expect(invalidateGmailCleanupPreview(claimed.userId, claimed.id)).toBe("mutation_started");
    expect(gmailCleanupJobs.has(claimed.id)).toBe(true);
    release?.();
    await operation.promise;
  });

  it("guards expiry before claiming Trash and requires Start over in the client", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const confirm = cleanup.slice(
      cleanup.indexOf("export async function confirmGmailCleanup"),
      cleanup.indexOf("async function performGmailCleanupConfirmation")
    );
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");

    expect(confirm.indexOf("job.confirmationExpiresAt < Date.now()")).toBeLessThan(
      confirm.indexOf("const operation = runOrJoinGmailCleanupOperation")
    );
    expect(client).toContain("This cleanup check has expired.");
    expect(client).toContain("For safety, check your selection again before moving messages.");
    expect(client).toMatch(/response\.status === 410[\s\S]+setSnapshotExpired\(true\)/);
    expect(client).toMatch(/gmail-cleanup\/start-over[\s\S]+resetPreview\(\)/);
  });

  it("keeps frozen context through expiry while removing Trash actions", () => {
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
    const contextGuard = client.slice(
      client.indexOf("const showFrozenReviewContext"),
      client.indexOf("const eligibleIndices")
    );
    const expiredBranch = client.slice(
      client.indexOf("{snapshotExpired ? ("),
      client.indexOf(') : job.status === "ready" ? (')
    );

    expect(contextGuard).toContain("reviewStarted");
    expect(contextGuard).not.toContain("snapshotExpired");
    expect(client).toMatch(/snapshotExpired[\s\S]+This cleanup check has expired\./);
    expect(expiredBranch).toContain("Start over");
    expect(expiredBranch).not.toContain("Move ");
    expect(client).toMatch(/activeOperation === "trash"[\s\S]+mutationOrVerificationActive/);
    expect(client).toMatch(/cleanupComplete[\s\S]+showFrozenReviewContext/);
  });
});
