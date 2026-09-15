import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assertOutlookCleanupDevelopmentRequest,
  formatOutlookCleanupDiagnostic,
  getOutlookCleanupBatchSize,
  getOutlookCleanupTotalBatches,
  isOutlookCleanupDevelopmentEnabled,
  outlookCleanupCountOptions,
  outlookCleanupMaximum
} from "@/lib/domain/outlook-cleanup";
import {
  decryptCleanupStateWithKey,
  encryptCleanupStateWithKey
} from "@/lib/server/crypto";
import { createCleanupJobStateCodec } from "@/lib/server/cleanup-job-store";
import {
  executeOutlookMoves,
  executeOutlookUndo,
  prepareOutlookJob,
  type OutlookCleanupProviderPort
} from "@/lib/server/outlook-cleanup";
import {
  getOutlookCleanupLedgers,
  serializeOutlookCleanupJob,
  type OutlookCleanupStoredJob
} from "@/lib/server/outlook-cleanup-store";

describe("Outlook durable cleanup", () => {
  it("retains all 155 encrypted recovery checkpoints for 500 moves and Undo", async () => {
    const job = storedJob(500, "created");
    const checkpoints: OutlookCleanupStoredJob[] = [];
    const save = async () => { checkpoints.push(structuredClone(job)); };
    const provider = fakeProvider({
      async *scanMetadata() {
        yield { records: Array.from({ length: 500 }, (_, index) => record(`id-${index + 1}`)) };
      }
    });
    await prepareOutlookJob(job, provider, save);
    expect(checkpoints).toHaveLength(2);
    job.view.status = "running";
    await executeOutlookMoves(job, provider, save);
    expect(checkpoints).toHaveLength(79);
    expect(job.view.movedVerified).toBe(500);
    job.view.status = "undoing";
    job.view.undoStatus = "running";
    await executeOutlookUndo(job, provider, save);
    expect(checkpoints).toHaveLength(155);
    expect(job.view.restoredVerified).toBe(500);
    // Each dispatched batch and its returned IDs still have their own recovery boundary.
    expect(checkpoints.filter((snapshot) => snapshot.payload.targets.some((target) => target.state === "move_dispatched"))).toHaveLength(25);
  });

  it("is development-only and caps requests at 500", () => {
    expect(outlookCleanupMaximum).toBe(500);
    expect(outlookCleanupCountOptions).toEqual([5, 10, 25, 500]);
    expect([1, 25, 26, 100, 101, 500].map(getOutlookCleanupBatchSize)).toEqual([5, 5, 10, 10, 20, 20]);
    expect(assertOutlookCleanupDevelopmentRequest({
      enabled: true,
      fixtureMode: false,
      nodeEnv: "development",
      requestedCount: 500
    })).toBe(500);
    for (const requestedCount of [0, 501, 1_000]) {
      expect(() => assertOutlookCleanupDevelopmentRequest({
        enabled: true,
        fixtureMode: false,
        nodeEnv: "development",
        requestedCount
      })).toThrow(/between 1 and 500/);
    }
    expect(() => assertOutlookCleanupDevelopmentRequest({
      enabled: true,
      fixtureMode: false,
      nodeEnv: "production",
      requestedCount: 500
    })).toThrow(/disabled/);
    expect(() => assertOutlookCleanupDevelopmentRequest({
      enabled: true,
      fixtureMode: true,
      nodeEnv: "development",
      requestedCount: 500
    })).toThrow(/disabled/);
    expect(isOutlookCleanupDevelopmentEnabled({
      microsoftOAuthEnabled: true,
      outlookCleanupEnabled: true,
      fixtureMode: false,
      nodeEnv: "development"
    })).toBe(true);
  });

  it("freezes only the requested exact Suggested messages", async () => {
    const job = storedJob(3, "created");
    const provider = fakeProvider({
      async *scanMetadata() {
        yield { records: [record("id-1"), record("id-2"), record("id-3"), record("id-4")] };
      }
    });

    await prepareOutlookJob(job, provider, async () => undefined);

    expect(job.view.status).toBe("ready");
    expect(job.payload.targets.map((target) => target.originalMessageId)).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("batch-rechecks every frozen target before moving and never substitutes exclusions", async () => {
    const job = frozenJob(3);
    const events: string[] = [];
    const provider = fakeProvider({
      async getCleanupMessages(messageIds) {
        return messageIds.map((messageId) => {
          events.push(`recheck:${messageId}`);
          return {
            record: record(messageId, messageId === "id-2" ? { isStarred: true } : {}),
            parentFolderId: `original-folder-${messageId}`
          };
        });
      },
      async moveCleanupMessages(inputs) {
        return inputs.map(({ messageId }) => {
          events.push(`move:${messageId}`);
          return { outcome: "success" as const, messageId: `moved-${messageId}` };
        });
      }
    });

    await executeOutlookMoves(job, provider, async () => undefined);

    expect(events).toEqual([
      "recheck:id-1",
      "recheck:id-2",
      "recheck:id-3",
      "move:id-1",
      "move:id-3"
    ]);
    expect(job.view).toMatchObject({
      approved: 2,
      excludedBySafety: 1,
      movedVerified: 2,
      failed: 0,
      uncertain: 0,
      status: "complete",
      undoAvailable: true
    });
    expect(job.payload.targets[1]).toMatchObject({ originalMessageId: "id-2", state: "excluded" });
    expect(job.payload.targets).toHaveLength(3);
  });

  it("refreshes participation evidence before mutation and excludes newly participated mail", async () => {
    const job = frozenJob(2);
    const move = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `moved-${messageId}` }))
    );
    const provider = fakeProvider({
      scanParticipatedConversationIds: async () => new Set(["newly-participated"]),
      async getCleanupMessages(messageIds) {
        return messageIds.map((messageId) => ({
          record: record(messageId, messageId === "id-1" ? { conversationId: "newly-participated" } : {}),
          parentFolderId: `original-folder-${messageId}`
        }));
      },
      moveCleanupMessages: move
    });

    await executeOutlookMoves(job, provider, async () => undefined);

    expect(job.payload.participatedConversationIds).toEqual(["newly-participated"]);
    expect(job.payload.targets[0].state).toBe("excluded");
    expect(move).toHaveBeenCalledTimes(1);
    expect(move.mock.calls[0][0]).toEqual([{ messageId: "id-2", destinationFolderId: "deleted-items-folder" }]);
  });

  it("uses changed destination IDs for verification and exact original-folder Undo", async () => {
    const job = frozenJob(2);
    const moveCalls: Array<{ id: string; destination: string; operation: string }> = [];
    const verifyCalls: Array<{ id: string; folder: string; operation: string }> = [];
    const provider = fakeProvider({
      async moveCleanupMessages(inputs, operation) {
        return inputs.map(({ messageId: id, destinationFolderId: destination }) => {
          moveCalls.push({ id, destination, operation });
          return {
            outcome: "success" as const,
            messageId: operation === "cleanup_move" ? `destination-copy-${id}` : `restored-copy-${id}`
          };
        });
      },
      async verifyCleanupMessageLocations(inputs, operation) {
        return inputs.map(({ messageId: id, destinationFolderId: folder }) => {
          verifyCalls.push({ id, folder, operation });
          return true;
        });
      }
    });

    await executeOutlookMoves(job, provider, async () => undefined);
    job.view.status = "undoing";
    job.view.undoStatus = "running";
    await executeOutlookUndo(job, provider, async () => undefined);

    expect(moveCalls).toContainEqual({
      id: "destination-copy-id-1",
      destination: "original-folder-id-1",
      operation: "cleanup_restore"
    });
    expect(verifyCalls).toContainEqual({
      id: "restored-copy-destination-copy-id-1",
      folder: "original-folder-id-1",
      operation: "cleanup_restore_verify"
    });
    expect(job.view).toMatchObject({
      movedVerified: 2,
      restoredVerified: 2,
      status: "undo_complete",
      undoStatus: "complete"
    });
  });

  it("fails a mutation batch closed and does not start the next chunk", async () => {
    const job = frozenJob(6);
    const move = vi.fn(async (inputs: readonly { messageId: string }[]) => inputs.map(({ messageId }, index) =>
      index === 0
        ? { outcome: "success" as const, messageId: `moved-${messageId}` }
        : index === 1
          ? { outcome: "uncertain" as const }
          : { outcome: "rejected" as const }
    ));
    const provider = fakeProvider({ moveCleanupMessages: move });

    await executeOutlookMoves(job, provider, async () => undefined);

    expect(move).toHaveBeenCalledTimes(1);
    expect(move.mock.calls[0][0]).toHaveLength(getOutlookCleanupBatchSize(job.view.requested));
    expect(job.payload.targets[5].state).toBe("frozen");
    expect(job.view).toMatchObject({
      movedVerified: 1,
      uncertain: 1,
      status: "uncertain",
      undoAvailable: true,
      undoStatus: "uncertain"
    });
  });

  it("verifies every returned ID in the chunk and stops before the next chunk on uncertainty", async () => {
    const job = frozenJob(6);
    const move = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `moved-${messageId}` }))
    );
    const verify = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => messageId !== "moved-id-2")
    );
    const provider = fakeProvider({
      moveCleanupMessages: move,
      verifyCleanupMessageLocations: verify
    });

    await executeOutlookMoves(job, provider, async () => undefined);

    expect(move).toHaveBeenCalledTimes(1);
    expect(job.payload.targets[1].state).toBe("move_uncertain");
    expect(job.payload.targets[4].state).toBe("moved_verified");
    expect(job.payload.targets[5].state).toBe("frozen");
    expect(job.view).toMatchObject({ movedVerified: 4, failed: 0, uncertain: 1, status: "uncertain", undoAvailable: true });
  });

  it("stops before the next Undo chunk after an unverified restore", async () => {
    const job = frozenJob(6);
    const provider = fakeProvider({
      async verifyCleanupMessageLocations(inputs, operation) {
        return inputs.map((_, index) => operation !== "cleanup_restore_verify" || index !== 0);
      }
    });
    await executeOutlookMoves(job, provider, async () => undefined);
    job.view.status = "undoing";
    job.view.undoStatus = "running";

    await executeOutlookUndo(job, provider, async () => undefined);

    expect(job.payload.targets[0].state).toBe("restore_uncertain");
    expect(job.payload.targets[4].state).toBe("restored_verified");
    expect(job.payload.targets[5].state).toBe("moved_verified");
    expect(job.view).toMatchObject({
      restoredVerified: 4,
      uncertain: 1,
      status: "uncertain",
      undoAvailable: true,
      undoStatus: "uncertain"
    });
  });

  it("reduces a successful 25-message cleanup and Undo to five batches per phase", async () => {
    const job = frozenJob(25);
    const recheck = vi.fn(async (messageIds: readonly string[]) => messageIds.map((messageId) => ({
      record: record(messageId),
      parentFolderId: `original-folder-${messageId}`
    })));
    const move = vi.fn(async (
      inputs: readonly { messageId: string }[],
      operation: "cleanup_move" | "cleanup_restore"
    ) => inputs.map(({ messageId }) => ({
      outcome: "success" as const,
      messageId: operation === "cleanup_move" ? `moved-${messageId}` : `restored-${messageId}`
    })));
    const verify = vi.fn(async (inputs: readonly { messageId: string }[]) => inputs.map(() => true));
    const provider = fakeProvider({
      getCleanupMessages: recheck,
      moveCleanupMessages: move,
      verifyCleanupMessageLocations: verify
    });

    await executeOutlookMoves(job, provider, async () => undefined);
    job.view.status = "undoing";
    job.view.undoStatus = "running";
    await executeOutlookUndo(job, provider, async () => undefined);

    expect(recheck).toHaveBeenCalledTimes(5);
    expect(move).toHaveBeenCalledTimes(10);
    expect(verify).toHaveBeenCalledTimes(10);
    for (const call of [...recheck.mock.calls, ...move.mock.calls, ...verify.mock.calls]) {
      expect(call[0].length).toBeLessThanOrEqual(job.view.effectiveBatchSize);
    }
    expect(job.view).toMatchObject({
      movedVerified: 25,
      restoredVerified: 25,
      failed: 0,
      uncertain: 0,
      status: "undo_complete"
    });
  });

  it("uses the same adaptive size for every cleanup and Undo phase", async () => {
    const job = frozenJob(26);
    const recheck = vi.fn(async (messageIds: readonly string[]) => messageIds.map((messageId) => ({
      record: record(messageId),
      parentFolderId: `original-folder-${messageId}`
    })));
    const move = vi.fn(async (inputs: readonly { messageId: string }[], operation: "cleanup_move" | "cleanup_restore") =>
      inputs.map(({ messageId }) => ({
        outcome: "success" as const,
        messageId: operation === "cleanup_move" ? `moved-${messageId}` : `restored-${messageId}`
      }))
    );
    const verify = vi.fn(async (inputs: readonly { messageId: string }[]) => inputs.map(() => true));
    const provider = fakeProvider({
      getCleanupMessages: recheck,
      moveCleanupMessages: move,
      verifyCleanupMessageLocations: verify
    });

    await executeOutlookMoves(job, provider, async () => undefined);
    job.view.status = "undoing";
    job.view.undoStatus = "running";
    await executeOutlookUndo(job, provider, async () => undefined);

    expect(job.view.effectiveBatchSize).toBe(10);
    expect(job.view.totalBatches).toBe(3);
    expect(job.view.undoTotalBatches).toBe(3);
    expect(recheck).toHaveBeenCalledTimes(3);
    expect(move).toHaveBeenCalledTimes(6);
    expect(verify).toHaveBeenCalledTimes(6);
    for (const call of [...recheck.mock.calls, ...move.mock.calls, ...verify.mock.calls]) {
      expect(call[0].length).toBeLessThanOrEqual(10);
    }
  });

  it("accounts for HTTP round trips by cleanup and Undo phase", async () => {
    const job = frozenJob(5);
    let requests = 0;
    const provider = fakeProvider({
      getScanMetrics: () => ({ requests }),
      scanParticipatedConversationIds: async () => {
        requests += 1;
        return new Set<string>();
      },
      getCleanupSafetyContext: async () => {
        requests += 1;
        return {
          knownFolderIds: ["inbox-folder", "deleted-items-folder"],
          kindByFolderId: [],
          sentFolderIds: [],
          deletedItemsFolderId: "deleted-items-folder"
        };
      },
      getCleanupMessages: async (messageIds) => {
        requests += 1;
        return messageIds.map((messageId) => ({
          record: record(messageId),
          parentFolderId: `original-folder-${messageId}`
        }));
      },
      moveCleanupMessages: async (inputs, operation) => {
        requests += 1;
        return inputs.map(({ messageId }) => ({
          outcome: "success" as const,
          messageId: operation === "cleanup_move" ? `moved-${messageId}` : `restored-${messageId}`
        }));
      },
      verifyCleanupMessageLocations: async (inputs) => {
        requests += 1;
        return inputs.map(() => true);
      }
    });

    await executeOutlookMoves(job, provider, async () => undefined);
    job.view.status = "undoing";
    job.view.undoStatus = "running";
    await executeOutlookUndo(job, provider, async () => undefined);

    expect(job.view.httpRoundTripsByPhase).toEqual({
      preflight: 2,
      finalRecheck: 1,
      move: 1,
      verification: 1,
      undoMove: 1,
      undoVerification: 1
    });
  });

  it("processes and restores 500 exact targets across 25 adaptive batches", async () => {
    const job = frozenJob(500);
    const recheck = vi.fn(async (messageIds: readonly string[]) => messageIds.map((messageId) => ({
      record: record(messageId),
      parentFolderId: `original-folder-${messageId}`
    })));
    const move = vi.fn(async (inputs: readonly { messageId: string }[], operation: "cleanup_move" | "cleanup_restore") =>
      inputs.map(({ messageId }) => ({
        outcome: "success" as const,
        messageId: operation === "cleanup_move" ? `moved-${messageId}` : `restored-${messageId}`
      }))
    );
    const verify = vi.fn(async (inputs: readonly { messageId: string }[]) => inputs.map(() => true));
    const provider = fakeProvider({
      getCleanupMessages: recheck,
      moveCleanupMessages: move,
      verifyCleanupMessageLocations: verify
    });

    await executeOutlookMoves(job, provider, async () => undefined);

    expect(recheck).toHaveBeenCalledTimes(25);
    expect(move).toHaveBeenCalledTimes(25);
    expect(verify).toHaveBeenCalledTimes(25);
    expect(job.view).toMatchObject({
      status: "complete",
      checked: 500,
      approved: 500,
      movedVerified: 500,
      chunksCompleted: 5,
      totalChunks: 5,
      effectiveBatchSize: 20,
      batchesCompleted: 25,
      totalBatches: 25,
      uncertain: 0,
      undoAvailable: true
    });

    job.view.status = "undoing";
    job.view.undoStatus = "running";
    job.view.undoAvailable = false;
    await executeOutlookUndo(job, provider, async () => undefined);

    expect(move).toHaveBeenCalledTimes(50);
    expect(verify).toHaveBeenCalledTimes(50);
    expect(job.view).toMatchObject({
      status: "undo_complete",
      restoredVerified: 500,
      undoBatchesCompleted: 25,
      undoTotalBatches: 25,
      uncertain: 0
    });
    expect(job.payload.targets.every((target) => target.state === "restored_verified")).toBe(true);
  });

  it("continues automatically one persisted batch at a time", async () => {
    const job = frozenJob(500);
    const move = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `moved-${messageId}` }))
    );
    let workflowSteps = 0;
    let outcome: "continue" | "stop" = "continue";

    while (outcome === "continue") {
      workflowSteps += 1;
      const result = await executeOutlookMoves(
        job,
        fakeProvider({ moveCleanupMessages: move }),
        async () => undefined,
        () => undefined,
        1
      );
      outcome = result.outcome;
      if (workflowSteps === 5) {
        expect(job.view).toMatchObject({
          status: "running",
          batchesCompleted: 5,
          chunksCompleted: 1,
          movedVerified: 100
        });
        expect(outcome).toBe("continue");
      }
    }

    expect(workflowSteps).toBe(25);
    expect(move).toHaveBeenCalledTimes(25);
    expect(job.view.status).toBe("complete");
    expect(job.view.batchesCompleted).toBe(25);
  });

  it("resumes read-only verification from a durably recorded move response", async () => {
    const job = frozenJob(10);
    const move = vi.fn();
    const verify = vi.fn(async (inputs: readonly { messageId: string }[]) => inputs.map(() => true));
    job.payload.cleanupSafetyContext = await fakeProvider().getCleanupSafetyContext();
    job.payload.activeMoveBatchIndexes = [0, 1, 2, 3, 4];
    for (let index = 0; index < 5; index += 1) {
      job.payload.targets[index].state = "move_dispatched";
      job.payload.targets[index].originalFolderId = `original-folder-id-${index + 1}`;
      job.payload.targets[index].movedMessageId = `returned-moved-id-${index + 1}`;
    }
    job.view.checked = 5;
    job.view.approved = 5;

    const result = await executeOutlookMoves(
      job,
      fakeProvider({ moveCleanupMessages: move, verifyCleanupMessageLocations: verify }),
      async () => undefined,
      () => undefined,
      1
    );

    expect(result.outcome).toBe("continue");
    expect(move).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(job.view.movedVerified).toBe(5);
    expect(job.view.batchesCompleted).toBe(1);
  });

  it("offers recovery Undo only for the exact verified ledger after a known partial stop", async () => {
    const job = frozenJob(10);
    for (let index = 0; index < 5; index += 1) {
      job.payload.targets[index] = {
        ...job.payload.targets[index],
        state: "moved_verified",
        originalFolderId: `original-folder-${index + 1}`,
        movedMessageId: `moved-id-${index + 1}`
      };
    }
    job.view.status = "failed";
    job.view.movedVerified = 5;
    job.view.undoAvailable = true;
    job.view.undoStatus = "available";
    job.view.status = "undoing";
    job.view.undoStatus = "running";
    const restore = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `restored-${messageId}` }))
    );

    await executeOutlookUndo(
      job,
      fakeProvider({ moveCleanupMessages: restore }),
      async () => undefined
    );

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0][0].map((input) => input.messageId)).toEqual([
      "moved-id-1",
      "moved-id-2",
      "moved-id-3",
      "moved-id-4",
      "moved-id-5"
    ]);
    expect(job.view.restoredVerified).toBe(5);
    expect(job.payload.targets.slice(5).every((target) => target.state === "frozen")).toBe(true);
  });

  it("recovers only verified moves across batches while failed and uncertain targets remain excluded", async () => {
    const job = frozenJob(16);
    const provider = fakeProvider({
      async moveCleanupMessages(inputs) {
        return inputs.map(({ messageId }) => messageId === "id-13"
          ? { outcome: "uncertain" as const }
          : messageId === "id-14"
            ? { outcome: "rejected" as const }
            : { outcome: "success" as const, messageId: `moved-${messageId}` });
      }
    });
    await executeOutlookMoves(job, provider, async () => undefined);
    expect(job.view).toMatchObject({ status: "uncertain", movedVerified: 13, failed: 1, uncertain: 1, undoAvailable: true });
    expect(getOutlookCleanupLedgers(job).verifiedMoved).toHaveLength(13);
    expect(job.payload.targets[15].state).toBe("frozen");
    const forward = vi.fn();
    job.view.status = "running";
    await executeOutlookMoves(job, fakeProvider({ moveCleanupMessages: forward }), async () => undefined);
    expect(forward).not.toHaveBeenCalled();

    const exact = getOutlookCleanupLedgers(job).verifiedMoved.map((target) => ({
      messageId: target.movedMessageId!, destinationFolderId: target.originalFolderId!
    }));
    const restore = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `restored-${messageId}` })));
    job.view.status = "undoing";
    let result;
    do {
      result = await executeOutlookUndo(job, fakeProvider({ moveCleanupMessages: restore }), async () => undefined, 1);
    } while (result.outcome === "continue");
    expect(restore.mock.calls.flatMap(([inputs]) => inputs)).toEqual(exact);
    expect(restore).toHaveBeenCalledTimes(3);
    expect(job.view).toMatchObject({
      status: "uncertain", undoStatus: "uncertain", restoredVerified: 13, movedVerified: 13,
      failed: 1, uncertain: 1, recoverableCount: 0, undoAvailable: false, undoMode: "recovery"
    });
    expect(job.payload.targets[12].state).toBe("move_uncertain");
    expect(job.payload.targets[13].state).toBe("move_failed");
    expect(job.payload.targets[15].state).toBe("frozen");
    const browser = serializeOutlookCleanupJob(job);
    const summary = formatOutlookCleanupDiagnostic(browser);
    expect(summary).toContain("Undo mode: recovery");
    expect(summary).toContain("Verified messages available for recovery: 0");
    expect(summary).toContain("Uncertain: 1");
    expect(summary).toContain("Undo status: uncertain");
    expect(JSON.stringify(browser) + summary).not.toMatch(/moved-id|original-folder|sender@example|originalMessageId|movedMessageId/);
  });

  it("resumes encrypted recovery after response persistence without repeating restore mutations", async () => {
    const job = frozenJob(12);
    await executeOutlookMoves(job, fakeProvider(), async () => undefined);
    job.payload.targets[11].state = "move_uncertain";
    job.view.uncertain = 1;
    job.view.status = "undoing";
    job.view.undoMode = "recovery";
    const key = Buffer.alloc(32, 19);
    const codec = createCleanupJobStateCodec<OutlookCleanupStoredJob>({
      encrypt: (value) => encryptCleanupStateWithKey(value, key),
      decrypt: (value) => decryptCleanupStateWithKey(value, key)
    });
    let persisted = codec.encode(job);
    const restore = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `restored-${messageId}` })));
    const verify = vi.fn(async (inputs: readonly { messageId: string }[]) => inputs.map(() => true));
    const provider = fakeProvider({ moveCleanupMessages: restore, verifyCleanupMessageLocations: verify });
    await expect(executeOutlookUndo(job, provider, async () => {
      persisted = codec.encode(job);
      if (job.payload.targets.some((target) => target.state === "restore_dispatched")) throw new Error("process replaced");
    })).rejects.toThrow("process replaced");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
    expect(persisted).not.toMatch(/moved-id|original-folder|sender@example/);
    let replacement = codec.decode(persisted);
    let result;
    do {
      result = await executeOutlookUndo(replacement, provider, async () => {
        persisted = codec.encode(replacement);
      }, 1);
      replacement = codec.decode(persisted);
    } while (result.outcome === "continue");
    expect(restore.mock.calls.flatMap(([inputs]) => inputs.map((input) => input.messageId)))
      .toEqual(Array.from({ length: 11 }, (_, index) => `moved-id-${index + 1}`));
    expect(verify.mock.calls[0][0]).toEqual(Array.from({ length: 5 }, (_, index) => ({
      messageId: `restored-moved-id-${index + 1}`, destinationFolderId: `original-folder-id-${index + 1}`
    })));
    expect(replacement.view).toMatchObject({ status: "uncertain", undoStatus: "uncertain", restoredVerified: 11, uncertain: 1 });
    await executeOutlookUndo(replacement, provider, async () => undefined);
    expect(restore).toHaveBeenCalledTimes(3);
  });

  it("never replays uncertain restore dispatch and allows later explicit recovery of untouched verified targets", async () => {
    const job = frozenJob(12);
    await executeOutlookMoves(job, fakeProvider(), async () => undefined);
    job.payload.targets[11].state = "move_uncertain";
    job.view.uncertain = 1;
    job.view.status = "undoing";
    const restore = vi.fn();
    await expect(executeOutlookUndo(job, fakeProvider({ moveCleanupMessages: restore }), async () => {
      if (job.payload.targets.some((target) => target.state === "restore_dispatching")) throw new Error("process replaced");
    })).rejects.toThrow("process replaced");
    const replacement = structuredClone(job);
    await executeOutlookUndo(replacement, fakeProvider({ moveCleanupMessages: restore }), async () => undefined);
    expect(restore).not.toHaveBeenCalled();
    expect(replacement.view).toMatchObject({ status: "uncertain", uncertain: 6, recoverableCount: 6, undoAvailable: true });
    // An explicit subsequent Recovery Undo never includes the ambiguous first batch.
    replacement.view.status = "undoing";
    const exactRestore = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => ({ outcome: "success" as const, messageId: `restored-${messageId}` })));
    await executeOutlookUndo(replacement, fakeProvider({ moveCleanupMessages: exactRestore }), async () => undefined);
    expect(exactRestore.mock.calls.flatMap(([inputs]) => inputs.map((input) => input.messageId)))
      .toEqual(Array.from({ length: 6 }, (_, index) => `moved-id-${index + 6}`));
    expect(replacement.view).toMatchObject({ status: "uncertain", undoStatus: "uncertain", uncertain: 6, restoredVerified: 6, undoAvailable: false });
    expect(replacement.payload.targets.slice(0, 5).every((target) => target.state === "restore_uncertain")).toBe(true);
  });

  it.each([false, true])("reports partial restore rejection truthfully with prior uncertainty=%s", async (priorUncertainty) => {
    const job = frozenJob(8);
    await executeOutlookMoves(job, fakeProvider(), async () => undefined);
    if (priorUncertainty) {
      job.payload.targets[7].state = "move_uncertain";
      job.view.uncertain = 1;
    }
    job.view.status = "undoing";
    const restore = vi.fn(async (inputs: readonly { messageId: string }[]) =>
      inputs.map(({ messageId }) => messageId === "moved-id-2"
        ? { outcome: "rejected" as const }
        : { outcome: "success" as const, messageId: `restored-${messageId}` }));
    await executeOutlookUndo(job, fakeProvider({ moveCleanupMessages: restore }), async () => undefined);
    expect(job.view).toMatchObject({
      status: priorUncertainty ? "uncertain" : "partial", undoStatus: priorUncertainty ? "uncertain" : "partial",
      restoredVerified: priorUncertainty ? 6 : 7, failed: 1, uncertain: priorUncertainty ? 1 : 0, undoAvailable: false
    });
    expect(getOutlookCleanupLedgers(job).failed.map((target) => target.originalMessageId)).toEqual(["id-2"]);
    await executeOutlookUndo(job, fakeProvider({ moveCleanupMessages: restore }), async () => undefined);
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it("encrypts provider IDs, original folders, and sender identity in transient state", () => {
    const key = Buffer.alloc(32, 11);
    const codec = createCleanupJobStateCodec<OutlookCleanupStoredJob>({
      encrypt: (value) => encryptCleanupStateWithKey(value, key),
      decrypt: (value) => decryptCleanupStateWithKey(value, key)
    });
    const job = frozenJob(1);
    job.payload.targets[0].originalFolderId = "original-folder-private";
    job.payload.targets[0].movedMessageId = "moved-message-private";
    const ciphertext = codec.encode(job);

    expect(ciphertext).not.toMatch(/id-1|original-folder-private|moved-message-private|sender@example\.test/);
    expect(codec.decode(ciphertext).payload).toEqual(job.payload);
  });

  it("keeps the browser diagnostic aggregate-only", () => {
    const job = frozenJob(2);
    job.view.approved = 2;
    job.view.movedVerified = 2;
    job.view.graphRequests = 14;
    job.view.httpRoundTrips = 8;
    job.view.httpRoundTripsByPhase = {
      preflight: 2,
      finalRecheck: 1,
      move: 1,
      verification: 1,
      undoMove: 1,
      undoVerification: 1
    };
    job.view.graphSubrequests = 24;
    job.view.retries = 1;
    job.view.timingMs = {
      preflight: 100,
      finalRecheck: 20,
      move: 30,
      verification: 40,
      undoMove: 50,
      undoVerification: 60
    };
    job.view.status = "complete";
    job.view.undoStatus = "available";
    job.view.checked = 2;
    job.view.chunksCompleted = 1;
    job.view.totalChunks = 1;
    job.view.batchesCompleted = 1;
    job.view.totalBatches = 1;
    job.view.currentChunk = 1;
    job.view.currentBatch = 1;
    job.view.undoBatchesCompleted = 1;
    job.view.undoTotalBatches = 1;
    const summary = formatOutlookCleanupDiagnostic(job.view);

    for (const line of [
      "Requested: 2",
      "Checked: 2",
      "Approved: 2",
      "Moved/verified: 2",
      "Effective batch size: 5",
      "HTTP round trips: 8",
      "Preflight HTTP round trips: 2",
      "Final recheck HTTP round trips: 1",
      "Undo verification HTTP round trips: 1",
      "Graph subrequests: 24",
      "Chunks completed: 1/1",
      "Batches completed: 1/1",
      "Undo batches completed: 1/1",
      "Preflight: 100 ms",
      "Final recheck: 20 ms",
      "Undo verification: 60 ms",
      "Job status: complete",
      "Undo status: available"
    ]) expect(summary).toContain(line);
    expect(summary).not.toMatch(/id-1|original-folder|sender@example|messageId|folderId|subject|token/i);
  });

  it("uses the shared CleanupJob envelope and disables Workflow mutation retries", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const store = readFileSync("src/lib/server/outlook-cleanup-store.ts", "utf8");
    const workflow = readFileSync("src/workflows/provider-cleanup.ts", "utf8");
    const provider = readFileSync("src/lib/providers/microsoft/provider.ts", "utf8");
    const route = readFileSync("app/api/dev/outlook-cleanup/status/route.ts", "utf8");
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");

    expect(schema).toMatch(/model CleanupJob[\s\S]+transientState CleanupJobState\?/);
    expect(schema).toMatch(/model CleanupJobState[\s\S]+encryptedPayload String/);
    expect(store).toContain("PrismaCleanupJobStore<OutlookCleanupStoredJob>");
    expect(store).toContain('from "@/lib/server/cleanup-job-store"');
    expect(workflow).toContain('"use workflow"');
    expect(workflow).toContain('"use step"');
    expect(workflow).toContain("runProviderCleanupStep.maxRetries = 0");
    expect(workflow).toMatch(/while \(true\)[\s\S]+result\.outcome === "stop"/);
    expect(provider).toContain("/move`");
    expect(provider).not.toMatch(/permanentDelete|\/delete`/);
    expect(route).not.toMatch(/messageId|folderId|parentFolderId|senderAddress/);
    expect(client).toContain('cleanupEndpoint(provider, outlook || scalable ? "start" : "resolve", developmentMode, scalable)');
    expect(client).toContain('cleanupEndpoint(provider, "undo", developmentMode, Boolean(scalableJob))');
    expect(client).toContain("Copy Outlook cleanup summary");
  });

  it("keeps mailbox IDs and folder safety context out of browser and normal Prisma state", () => {
    const job = frozenJob(1);
    job.payload.targets[0].originalFolderId = "private-original-folder";
    job.payload.targets[0].movedMessageId = "private-moved-message";
    job.payload.cleanupSafetyContext = {
      knownFolderIds: ["private-inbox-folder"],
      kindByFolderId: [["private-deleted-folder", "deleted"]],
      sentFolderIds: ["private-sent-folder"],
      deletedItemsFolderId: "private-deleted-folder"
    };

    const browser = JSON.stringify(serializeOutlookCleanupJob(job));
    const schema = readFileSync("prisma/schema.prisma", "utf8");

    expect(browser).not.toMatch(/private-(?:original|moved|inbox|deleted|sent)/);
    expect(schema).not.toMatch(/MicrosoftMessageId|OutlookMessageId|OriginalFolderId|MovedMessageId/);
  });

  it("matches the Gmail review hierarchy while retaining the Outlook destination", () => {
    const client = readFileSync("src/components/product/GmailCleanupClient.tsx", "utf8");
    const outlookWorkspace = client.slice(
      client.indexOf("function OutlookCleanupWorkspace"),
      client.indexOf("function CopyOutlookCleanupSummaryButton")
    );

    expect(outlookWorkspace).toContain("Move up to {job.requested.toLocaleString()} to Deleted Items");
    expect(outlookWorkspace).toContain("Move up to {job.requested.toLocaleString()} messages to Deleted Items?");
    expect(outlookWorkspace).toContain("We will recheck these messages and leave protected email out.");
    expect(outlookWorkspace).toContain("Organizinbox never permanently deletes email.");
    expect(outlookWorkspace).not.toContain("They&apos;re still recoverable in Outlook Deleted Items.");
    expect(outlookWorkspace).toContain('recovery={job.undoMode === "recovery"}');
    expect(outlookWorkspace).toContain('expiresAt={job.expiresAt}');
    expect(outlookWorkspace).toContain("Available for recovery");
    expect(outlookWorkspace).toContain("Some messages remain unresolved and are excluded from Recovery Undo.");
    expect(outlookWorkspace).toContain("Outlook cleanup progress");
    expect(outlookWorkspace).toContain("Messages checked");
    expect(outlookWorkspace).toContain("Current chunk");
    expect(outlookWorkspace).toContain("Current batch");
    expect(outlookWorkspace).not.toContain("Review move to Deleted Items");
  });

  it("keeps Gmail route boundaries unchanged", () => {
    expect(readFileSync("app/api/dev/gmail-scalable-cleanup/start/route.ts", "utf8"))
      .toContain("startGmailScalableCleanup");
    expect(readFileSync("src/lib/server/gmail-scalable-live-workflow.ts", "utf8"))
      .toMatch(/provider: "gmail"/);
    expect(readFileSync("src/workflows/gmail-scalable-cleanup.ts", "utf8"))
      .toContain("gmailScalableCleanupWorkflow");
  });
});

function storedJob(requested: number, status: OutlookCleanupStoredJob["view"]["status"]): OutlookCleanupStoredJob {
  const now = Date.now();
  return {
    provider: "microsoft",
    userId: "user-1",
    acceptanceKey: "acceptance",
    version: 1,
    view: {
      provider: "microsoft",
      id: "job-1",
      status,
      requested,
      approved: 0,
      excludedBySafety: 0,
      movedVerified: 0,
      restoredVerified: 0,
      failed: 0,
      uncertain: 0,
      checked: 0,
      chunksCompleted: 0,
      totalChunks: Math.ceil(requested / 100),
      batchesCompleted: 0,
      totalBatches: getOutlookCleanupTotalBatches(requested),
      currentChunk: 0,
      currentBatch: 0,
      effectiveBatchSize: getOutlookCleanupBatchSize(requested),
      undoBatchesCompleted: 0,
      undoTotalBatches: 0,
      graphRequests: 0,
      httpRoundTrips: 0,
      graphSubrequests: 0,
      retries: 0,
      httpRoundTripsByPhase: {
        preflight: 0,
        finalRecheck: 0,
        move: 0,
        verification: 0,
        undoMove: 0,
        undoVerification: 0
      },
      timingMs: {
        preflight: 0,
        finalRecheck: 0,
        move: 0,
        verification: 0,
        undoMove: 0,
        undoVerification: 0
      },
      groupIndices: [0],
      undoAvailable: false,
      undoStatus: "not_available",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000
    },
    payload: {
      scanId: "scan-1",
      providerConnectionId: "connection-1",
      selectedSenders: [{ groupIndex: 0, senderKey: "sender@example.test" }],
      participatedConversationIds: [],
      targets: []
    }
  };
}

function frozenJob(requested: number) {
  const job = storedJob(requested, "running");
  job.payload.targets = Array.from({ length: requested }, (_, index) => ({
    originalMessageId: `id-${index + 1}`,
    groupIndex: 0,
    state: "frozen" as const
  }));
  return job;
}

function record(messageId: string, overrides: Record<string, unknown> = {}) {
  return {
    providerMessageId: messageId,
    provider: "microsoft" as const,
    senderAddress: "sender@example.test",
    receivedAt: new Date("2020-01-01T00:00:00Z"),
    isRead: false,
    listId: "list.example.test",
    hasListUnsubscribe: true,
    ...overrides
  };
}

function fakeProvider(overrides: Partial<OutlookCleanupProviderPort> = {}): OutlookCleanupProviderPort {
  return {
    async *scanMetadata() {
      yield { records: [] };
    },
    scanParticipatedConversationIds: async () => new Set<string>(),
    getCleanupSafetyContext: async () => ({
      knownFolderIds: ["inbox-folder", "deleted-items-folder"],
      kindByFolderId: [],
      sentFolderIds: [],
      deletedItemsFolderId: "deleted-items-folder"
    }),
    getDeletedItemsFolderId: async () => "deleted-items-folder",
    getCleanupMessages: async (messageIds) => messageIds.map((messageId) => ({
      record: record(messageId),
      parentFolderId: `original-folder-${messageId}`
    })),
    moveCleanupMessages: async (inputs, operation) => inputs.map(({ messageId }) => ({
      outcome: "success" as const,
      messageId: operation === "cleanup_move" ? `moved-${messageId}` : `restored-${messageId}`
    })),
    verifyCleanupMessageLocations: async (inputs) => inputs.map(() => true),
    ...overrides
  };
}
