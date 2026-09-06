import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/crypto")>();
  return {
    ...actual,
    encryptCleanupState: (value: string) => Buffer.from(value).toString("base64url"),
    decryptCleanupState: (value: string) => Buffer.from(value, "base64url").toString("utf8")
  };
});
import { runOrJoinGmailCleanupOperation } from "@/lib/server/gmail-cleanup-store";
import {
  createProgress,
  DurableLiveScanStore,
  MemoryScanStateRepository,
  nextExpiry
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

  it("atomically reuses a duplicate same-user/provider scan request", async () => {
    const store = new DurableLiveScanStore(new MemoryScanStateRepository());
    const userId = `scan-user-${crypto.randomUUID()}`;
    const first = await store.accept({
      userId,
      providerConnectionId: "gmail-connection",
      session: { progress: createProgress({ scanId: "scan-a", limit: "full", batchSize: 1000 }), expiresAt: nextExpiry() }
    });
    const duplicate = await store.accept({
      userId,
      providerConnectionId: "gmail-connection",
      session: { progress: createProgress({ scanId: "scan-b", limit: "full", batchSize: 1000 }), expiresAt: nextExpiry() }
    });

    expect(first.reused).toBe(false);
    expect(duplicate.reused).toBe(true);
    expect(duplicate.session.progress.scanId).toBe("scan-a");
    expect(duplicate.session.progress.duplicateStartCount).toBe(1);
  });

  it("isolates two users scanning simultaneously", async () => {
    const store = new DurableLiveScanStore(new MemoryScanStateRepository());
    const gmailUser = `gmail-scan-user-${crypto.randomUUID()}`;
    const outlookUser = `outlook-scan-user-${crypto.randomUUID()}`;
    const gmailProgress = createProgress({ scanId: "gmail-scan", provider: "gmail", limit: "full", batchSize: 1000 });
    const outlookProgress = createProgress({ scanId: "outlook-scan", provider: "microsoft", limit: "full", batchSize: 250 });

    await Promise.all([
      store.accept({
        userId: gmailUser,
        providerConnectionId: "gmail-connection",
        session: { progress: gmailProgress, expiresAt: nextExpiry() }
      }),
      store.accept({
        userId: outlookUser,
        providerConnectionId: "outlook-connection",
        session: { progress: outlookProgress, expiresAt: nextExpiry() }
      })
    ]);

    expect((await store.get(gmailUser, "gmail"))?.progress.scanId).toBe("gmail-scan");
    expect((await store.get(outlookUser, "microsoft"))?.progress.scanId).toBe("outlook-scan");
    await store.delete(gmailUser, "gmail");
    expect(await store.get(gmailUser, "gmail")).toBeUndefined();
    expect((await store.get(outlookUser, "microsoft"))?.progress.scanId).toBe("outlook-scan");
  });

  it("survives process replacement and isolates Gmail from Outlook for one user", async () => {
    const repository = new MemoryScanStateRepository();
    const firstProcess = new DurableLiveScanStore(repository);
    const userId = `replacement-user-${crypto.randomUUID()}`;
    await Promise.all([
      firstProcess.accept({
        userId,
        providerConnectionId: "gmail-connection",
        session: { progress: createProgress({ scanId: "gmail-durable", provider: "gmail", limit: "full", batchSize: 1000 }), expiresAt: nextExpiry() }
      }),
      firstProcess.accept({
        userId,
        providerConnectionId: "outlook-connection",
        session: { progress: createProgress({ scanId: "outlook-durable", provider: "microsoft", limit: "full", batchSize: 250 }), expiresAt: nextExpiry() }
      })
    ]);

    const replacementProcess = new DurableLiveScanStore(repository);
    expect((await replacementProcess.get(userId, "gmail"))?.progress.scanId).toBe("gmail-durable");
    expect((await replacementProcess.get(userId, "microsoft"))?.progress.scanId).toBe("outlook-durable");
    await replacementProcess.delete(userId, "gmail");
    expect(await replacementProcess.get(userId, "gmail")).toBeUndefined();
    expect((await replacementProcess.get(userId, "microsoft"))?.progress.scanId).toBe("outlook-durable");
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

    expect(client).toMatch(/pendingRef\.current \|\| isRunning/);
    expect(client).toMatch(/pendingRef\.current = true[\s\S]+setPending\(true\)/);
    expect(client).toMatch(/disabled=\{working\}/);
    expect(client).toContain("Scanning your inbox...");
    expect(client).toContain("Rescanning your inbox...");
    expect(client).toMatch(/finally[\s\S]+pendingRef\.current = false[\s\S]+setPending\(false\)/);
    expect(route).toContain("await createGmailScanSession");
    expect(route).not.toContain("clearLiveScan(session.userId)");
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
    expect(client).toMatch(/fetch\(provider === "microsoft" \? "\/api\/app\/microsoft-scan\/start" : "\/api\/app\/gmail-scan\/start", \{ method: "POST" \}\)/);
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
