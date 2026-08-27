import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runOrJoinGmailCleanupOperation } from "@/lib/server/gmail-cleanup-store";
import {
  clearLiveScan,
  createProgress,
  nextExpiry,
  reuseRunningLiveScan,
  setLiveScan
} from "@/lib/server/live-scan-store";

describe("transient operation idempotency", () => {
  it("joins concurrent cleanup submissions to one logical operation", async () => {
    let release: ((value: string) => void) | undefined;
    const providerWork = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const duplicate = vi.fn();
    const key = `test-operation-${crypto.randomUUID()}`;

    const first = runOrJoinGmailCleanupOperation(key, providerWork, duplicate);
    const second = runOrJoinGmailCleanupOperation(key, providerWork, duplicate);
    await Promise.resolve();

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(providerWork).toHaveBeenCalledOnce();
    expect(duplicate).toHaveBeenCalledOnce();

    release?.("completed");
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(["completed", "completed"]);
  });

  it("reuses an active scan and records the blocked duplicate without starting a new session", () => {
    const userId = `scan-user-${crypto.randomUUID()}`;
    const progress = createProgress({ scanId: "transient-scan", limit: "full", batchSize: 1000 });
    setLiveScan(userId, {
      progress,
      cancel: new AbortController(),
      expiresAt: nextExpiry()
    });

    const reused = reuseRunningLiveScan(userId);

    expect(reused?.progress).toBe(progress);
    expect(progress.duplicateStartCount).toBe(1);
    clearLiveScan(userId);
  });
});

describe("working-state contracts", () => {
  it("uses one accessible reduced-motion-safe operation status pattern", () => {
    const status = readFileSync("src/components/product/OperationStatus.tsx", "utf8");

    expect(status).toMatch(/aria-live="polite"/);
    expect(status).toMatch(/aria-busy="true"/);
    expect(status).toMatch(/role="status"/);
    expect(status).toMatch(/motion-safe:animate-spin/);
    expect(status).toMatch(/motion-reduce:animate-none/);
    expect(status).toContain("Elapsed:");
  });

  it("locks scan and rescan immediately and reuses a running server scan", () => {
    const client = readFileSync("src/components/product/GmailScanClient.tsx", "utf8");
    const route = readFileSync("app/api/app/gmail-scan/start/route.ts", "utf8");
    const reusePosition = route.indexOf("reuseRunningLiveScan");
    const clearPosition = route.indexOf("clearLiveScan(session.userId)");

    expect(client).toMatch(/pendingRef\.current \|\| isRunning/);
    expect(client).toMatch(/pendingRef\.current = true[\s\S]+setPending\(true\)/);
    expect(client).toMatch(/disabled=\{working\}/);
    expect(client).toContain("Scanning your inbox...");
    expect(client).toContain("Rescanning your inbox...");
    expect(client).toMatch(/finally[\s\S]+pendingRef\.current = false[\s\S]+setPending\(false\)/);
    expect(reusePosition).toBeGreaterThan(-1);
    expect(clearPosition).toBeGreaterThan(reusePosition);
  });

  it("locks resolution, benchmark, Trash, Undo, and result-page rescan before fetch", () => {
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");

    expect(client).toMatch(/if \(activeOperationRef\.current\) return false/);
    expect(client).toMatch(/activeOperationRef\.current = operation[\s\S]+setActiveOperation\(operation\)/);
    expect(client).toMatch(/title=\{`Checking \$\{requestedCount\.toLocaleString\(\)\} messages\.\.\.`\}/);
    expect(client).toContain("Running safety benchmark...");
    expect(client).toContain("Messages moved. Verifying cleanup...");
    expect(client).toContain("Restoring ");
    expect(client).toContain("Rescanning your inbox...");
    expect(client).toMatch(/disabled=\{!group\.eligible \|\| busy\}/);
    expect(client).toMatch(/id="cleanup-search"[\s\S]+disabled=\{busy\}/);
    expect(client).toMatch(/fetch\("\/api\/app\/gmail-scan\/start", \{ method: "POST" \}\)/);
  });

  it("claims and single-flights provider work while consuming terminal Trash and Undo actions", () => {
    const cleanup = readFileSync("src/lib/server/gmail-cleanup.ts", "utf8");
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    const confirm = cleanup.slice(
      cleanup.indexOf("export async function confirmGmailCleanup"),
      cleanup.indexOf("export async function undoGmailCleanup")
    );
    const undo = cleanup.slice(cleanup.indexOf("export async function undoGmailCleanup"));

    expect(store).toContain("runOrJoinGmailCleanupOperation");
    expect(confirm).toMatch(/runOrJoinGmailCleanupOperation[\s\S]+performGmailCleanupConfirmation/);
    expect(confirm.indexOf('status: "running"')).toBeLessThan(confirm.indexOf("batchModifyTrash"));
    expect(confirm).toMatch(/batchModifyTrash[\s\S]+trashVerification: "in_progress"[\s\S]+verifyMessagesInTrash/);
    expect(confirm).toMatch(/job\.status === "completed"[\s\S]+incrementGmailCleanupDuplicateSubmission/);
    expect(undo).toMatch(/runOrJoinGmailCleanupOperation[\s\S]+performGmailCleanupUndo/);
    expect(undo.indexOf('status: "undoing"')).toBeLessThan(undo.indexOf("untrashAndVerifyMessages"));
    expect(undo).toMatch(/job\.status === "undone" \|\| job\.status === "undo_partial" \|\| job\.status === "undo_failed"/);
  });

  it("consumes successful and partial Undo states without exposing the full action again", () => {
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
    const store = readFileSync("src/lib/server/gmail-cleanup-store.ts", "utf8");
    const undoResult = client.slice(client.indexOf("function UndoResult"), client.indexOf("function CleanupOperationStatus"));

    expect(store).toMatch(/job\.status === "completed"[\s\S]+job\.verifiedCount === job\.attemptedCount/);
    expect(client).toMatch(/job\.undoAvailable \? <button[\s\S]+>Undo<\/button> : null/);
    expect(undoResult).not.toContain("onUndo");
    expect(undoResult).toContain("Restore verification was not complete.");
  });
});
