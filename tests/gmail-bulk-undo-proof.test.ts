import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createGmailBulkUndoProofSummary,
  formatDevelopmentBulkUndoProofSummary,
  projectGmailBulkUndoQuota
} from "@/lib/domain/gmail-bulk-undo-proof-summary";
import {
  assertGmailBulkUndoProofInput,
  executeGmailBulkUndoProof,
  parseGmailBulkUndoProofRequest,
  type GmailBulkUndoProofResult
} from "@/lib/providers/gmail/bulk-undo-proof";
import { createBulkUndoRecoveryPlan } from "@/lib/server/gmail-cleanup-adjustments";
import { runOrJoinGmailCleanupOperation } from "@/lib/server/gmail-cleanup-store";

const ids = Array.from({ length: 25 }, (_, index) => `id-${index}`);

function proofSummary(result: GmailBulkUndoProofResult, overrides: Record<string, unknown> = {}) {
  return createGmailBulkUndoProofSummary({
    checkpointStatus: "success",
    verifiedCleanupMessages: 25,
    attemptedCount: result.attemptedCount,
    verifiedRestoredCount: result.verifiedRestoredCount,
    stillInTrashCount: result.failedCount,
    uncertainCount: result.uncertainCount,
    batchModifyRequests: result.batchModifyRequests,
    primaryVerificationRequests: result.verificationRequests,
    apiResult: result.apiResult,
    profileCheckpoints: 1,
    profileRequests: 1,
    historyListRequests: 1,
    historyPages: 1,
    historyPollingAttempts: 1,
    historyRetries: 0,
    historyVerifiedRestoredCount: 25,
    historyFallbackVerifiedCount: 0,
    historyFallbackRequests: 0,
    shadowUnresolvedCount: 0,
    mismatchWithPrimaryCount: 0,
    historyUnavailable: false,
    batchModifyUnitCost: 50,
    primaryVerificationUnitCost: 20,
    profileUnitCost: 1,
    historyListUnitCost: 2,
    shadowFallbackUnitCost: 20,
    mutationMs: result.mutationMs,
    primaryVerificationMs: result.verificationMs,
    historyVerificationMs: 100,
    totalMs: result.totalMs + 100,
    ...overrides
  });
}

describe("25-message Gmail bulk Undo proof gates", () => {
  it("requires both flags, approval, non-production, and exactly 25 unique IDs", () => {
    const valid = { enabled: true, historyShadowEnabled: true, approved: true, nodeEnv: "development", targetIds: ids };
    expect(assertGmailBulkUndoProofInput(valid)).toEqual(ids);
    expect(() => assertGmailBulkUndoProofInput({ ...valid, targetIds: ids.slice(0, 24) })).toThrow(/exactly 25/);
    expect(() => assertGmailBulkUndoProofInput({ ...valid, targetIds: [...ids, "id-25"] })).toThrow(/exactly 25/);
    expect(() => assertGmailBulkUndoProofInput({ ...valid, enabled: false })).toThrow(/disabled/);
    expect(() => assertGmailBulkUndoProofInput({ ...valid, historyShadowEnabled: false })).toThrow(/disabled/);
    expect(() => assertGmailBulkUndoProofInput({ ...valid, approved: false })).toThrow(/disabled/);
    expect(() => assertGmailBulkUndoProofInput({ ...valid, nodeEnv: "production" })).toThrow(/disabled/);
    expect(() => assertGmailBulkUndoProofInput({ ...valid, targetIds: [...ids.slice(0, 24), ids[0]] })).toThrow(/unique valid/);
  });

  it("defaults both proof flags off and requires a verified 25-of-25 server job", () => {
    const envExample = readFileSync(".env.example", "utf8");
    const config = readFileSync("src/lib/config.ts", "utf8");
    const route = readFileSync("app/api/dev/gmail-bulk-undo-proof/route.ts", "utf8");
    expect(envExample).toContain('GMAIL_BULK_UNDO_PROOF_ENABLED="false"');
    expect(envExample).toContain('GMAIL_BULK_UNDO_HISTORY_SHADOW_ENABLED="false"');
    expect(config).toMatch(/GMAIL_BULK_UNDO_HISTORY_SHADOW_ENABLED:[\s\S]+default\("false"\)/);
    expect(route).toMatch(/job\.status === "completed"/);
    expect(route).toMatch(/job\.attemptedCount === 25/);
    expect(route).toMatch(/job\.apiCandidates\.length === 25/);
    expect(route).toMatch(/job\.verifiedCount === 25/);
    expect(route).toMatch(/job\.failedCount === 0/);
    expect(route).toMatch(/job\.uncertainCount === 0/);
    expect(route).toMatch(/job\.apiCandidates\.map\(\(candidate\) => candidate\.apiMessageId\)/);
  });

  it("rejects client-supplied IDs and exposes the action only behind both server flags", () => {
    for (const field of ["ids", "targetIds", "messageIds"]) {
      expect(() => parseGmailBulkUndoProofRequest({ jobId: "job", approved: true, [field]: ids })).toThrow(/Invalid/);
    }
    const page = readFileSync("app/app/cleanup/page.tsx", "utf8");
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
    expect(page).toMatch(/gmailBulkUndoProofEnabled[\s\S]+gmailBulkUndoHistoryShadowEnabled[\s\S]+NODE_ENV !== "production"/);
    expect(client).toMatch(/job\.attemptedCount === 25[\s\S]+job\.verifiedCount === 25[\s\S]+job\.failedCount === 0[\s\S]+job\.uncertainCount === 0/);
    expect(client).toContain('body: JSON.stringify({ jobId: job.id, approved: true })');
  });
});

describe("25-message bulk mutation and primary verification", () => {
  it("sends one exact TRASH-only batchModify and 25 exact label reads", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const result = await executeGmailBulkUndoProof({
      accessToken: "secret-token",
      targetIds: ids,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
        if (String(url).endsWith("batchModify")) return new Response(null, { status: 204 });
        const id = decodeURIComponent(String(url).match(/\/messages\/([^?]+)/)?.[1] ?? "");
        return Response.json({ id, labelIds: ["INBOX"] });
      }
    });
    expect(result).toMatchObject({
      attemptedCount: 25,
      verifiedRestoredCount: 25,
      failedCount: 0,
      uncertainCount: 0,
      batchModifyRequests: 1,
      verificationRequests: 25,
      verifiedRestoredIds: ids
    });
    expect(requests.filter((request) => request.url.endsWith("batchModify"))).toHaveLength(1);
    expect(JSON.parse(requests[0].body!)).toEqual({ ids, addLabelIds: [], removeLabelIds: ["TRASH"] });
    expect(requests.slice(1)).toHaveLength(25);
    expect(requests.slice(1).every((request) => request.url.includes("format=metadata&fields=id,labelIds"))).toBe(true);
    expect(requests.map((request) => request.url).join("\n")).not.toMatch(/batchDelete|\/delete|expunge/i);
    expect(proofSummary(result)).toMatchObject({
      state: "success",
      primaryPass: true,
      shadowComparisonPass: true,
      result: "BULK_UNDO_25_PROOF_SUCCESS",
      totalProofUnits: 553
    });
  });

  it("classifies exact still-in-Trash and uncertain outcomes with invariant accounting", async () => {
    const result = await executeGmailBulkUndoProof({
      accessToken: "secret-token",
      targetIds: ids,
      fetchImpl: async (url) => {
        if (String(url).endsWith("batchModify")) return new Response(null, { status: 200 });
        const id = decodeURIComponent(String(url).match(/\/messages\/([^?]+)/)?.[1] ?? "");
        if (id === "id-0") return Response.json({ id, labelIds: ["TRASH"] });
        if (id === "id-1") return new Response("unavailable", { status: 503 });
        return Response.json({ id, labelIds: ["INBOX"] });
      }
    });
    expect(result).toMatchObject({ verifiedRestoredCount: 23, failedCount: 1, uncertainCount: 1 });
    expect(result.attemptedCount).toBe(result.verifiedRestoredCount + result.failedCount + result.uncertainCount);
    expect(proofSummary(result)).toMatchObject({
      primaryPass: false,
      state: "failed",
      result: "BULK_UNDO_25_PRIMARY_FAILED",
      fallbackMessages: 2
    });
  });

  it("does not verify or retry through another mutation strategy after API failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    const result = await executeGmailBulkUndoProof({ accessToken: "secret-token", targetIds: ids, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      apiResult: "failure",
      attemptedCount: 25,
      verifiedRestoredCount: 0,
      uncertainCount: 25,
      verificationRequests: 0
    });
    expect(proofSummary(result, {
      historyListRequests: 0,
      historyPages: 0,
      historyVerifiedRestoredCount: 0,
      shadowUnresolvedCount: 25
    })).toMatchObject({ result: "BULK_UNDO_25_MUTATION_FAILED" });
  });
});

describe("bulk Undo comparison, recovery, and diagnostics", () => {
  it("keeps primary success while blocking recommendation for unresolved shadow evidence or mismatch", async () => {
    const restored = await executeGmailBulkUndoProof({
      accessToken: "secret-token",
      targetIds: ids,
      fetchImpl: async (url) => {
        if (String(url).endsWith("batchModify")) return new Response(null, { status: 200 });
        const id = decodeURIComponent(String(url).match(/\/messages\/([^?]+)/)?.[1] ?? "");
        return Response.json({ id, labelIds: ["INBOX"] });
      }
    });
    expect(proofSummary(restored, {
      historyVerifiedRestoredCount: 24,
      shadowUnresolvedCount: 1
    })).toMatchObject({
      primaryPass: true,
      shadowComparisonPass: false,
      result: "BULK_UNDO_25_HISTORY_SHADOW_FAILED"
    });
    expect(proofSummary(restored, { mismatchWithPrimaryCount: 1 })).toMatchObject({
      shadowComparisonPass: false,
      result: "BULK_UNDO_25_HISTORY_SHADOW_FAILED"
    });
  });

  it("single-flights concurrent proof submissions and blocks a second persisted attempt", async () => {
    let release: (() => void) | undefined;
    const work = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const duplicate = vi.fn();
    const key = `bulk-undo-proof:${crypto.randomUUID()}`;
    const first = runOrJoinGmailCleanupOperation(key, work, duplicate);
    const second = runOrJoinGmailCleanupOperation(key, work, duplicate);
    await Promise.resolve();
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(work).toHaveBeenCalledOnce();
    release?.();
    await Promise.all([first.promise, second.promise]);
    const route = readFileSync("app/api/dev/gmail-bulk-undo-proof/route.ts", "utf8");
    expect(route).toContain("if (job.bulkUndoProof)");
    expect(route).toContain("incrementGmailBulkUndoProofDuplicateSubmission");
  });

  it("reconciles failed proof state and individually untrashes only confirmed Trash targets", () => {
    expect(createBulkUndoRecoveryPlan({
      attemptedCount: 25,
      verifiedCount: 2,
      failedCount: 22,
      uncertainCount: 1,
      durationMs: 50,
      verifiedIds: ["still-trash-a", "still-trash-b"],
      failedIds: Array.from({ length: 22 }, (_, index) => `already-restored-${index}`),
      uncertainIds: ["unknown"]
    })).toMatchObject({
      recoveryIds: ["still-trash-a", "still-trash-b"],
      uncertainCount: 1
    });
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const recovery = cleanup.slice(
      cleanup.indexOf("async function performFailedBulkUndoProofRecovery"),
      cleanup.indexOf("export function parseCleanupCount")
    );
    expect(recovery).toMatch(/verifyMessagesInTrash\(apiMessageIds\)[\s\S]+createBulkUndoRecoveryPlan\(currentState\)/);
    expect(recovery).toMatch(/untrashAndVerifyMessages\(recoveryIds\)/);
    expect(recovery).not.toMatch(/untrashAndVerifyMessages\(apiMessageIds\)/);
    expect(recovery).not.toMatch(/batchModify|batchDelete|\/delete/);
  });

  it("formats privacy-safe measured and projected quota diagnostics", async () => {
    const result = await executeGmailBulkUndoProof({
      accessToken: "secret-token",
      targetIds: ids,
      fetchImpl: async (url) => {
        if (String(url).endsWith("batchModify")) return new Response(null, { status: 200 });
        const id = decodeURIComponent(String(url).match(/\/messages\/([^?]+)/)?.[1] ?? "");
        return Response.json({ id, labelIds: ["INBOX"] });
      }
    });
    const summary = formatDevelopmentBulkUndoProofSummary(proofSummary(result));
    for (const section of ["Input", "Bulk mutation", "Primary verification", "History shadow", "Accounting", "Quota", "Scalable projected Undo", "Performance", "Fallback", "Result", "Safety"]) {
      expect(summary).toContain(`\n${section}\n`);
    }
    expect(summary).toContain("Primary verification units: 500");
    expect(summary).toContain("BULK_UNDO_25_PROOF_SUCCESS");
    expect(summary).not.toMatch(/secret-token|id-0|historyId|private-job|authorization: bearer|response-body/i);
    expect(projectGmailBulkUndoQuota(1).map((entry) => entry.projectedCoreUnits)).toEqual([53, 53, 53, 53, 265]);
    expect(projectGmailBulkUndoQuota(1).map((entry) => entry.worstCaseGetFallbackUnits)).toEqual([2_000, 5_000, 10_000, 20_000, 100_000]);
  });
});
