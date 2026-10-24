import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { outlookVerificationBatchesPerStep, outlookVerificationStepBudgetMs } from "@/lib/domain/outlook-verification-chunk";
import { persistenceErrorDiagnostic } from "@/lib/server/persistence-error-diagnostic";

export type VerificationStage = "request_received" | "session_resolution" | "authorization" | "retention_purge" | "credit_entitlement" |
  "connection_readiness" | "report_retrieval" | "database_read" | "database_write" | "decrypt_deserialize" |
  "encrypt_serialize" | "candidate_building" | "job_creation" | "workflow_invocation" | "workflow_startup" |
  "workflow_gap" | "worker_unit" | "lease_claim" | "lease_release" | "credentials" | "safety_context" |
  "participation_index" | "targeted_graph" | "safety_evaluation" | "result_aggregation" | "job_persistence" |
  "aggregate_update" | "response_generation" | "request_total" | "provider_coordination" | "header_normalization" | "token_refresh";
export type VerificationTrace = {
  correlationId: string; receivedAt: number; scheduledAt?: number; lastStepEndedAt?: number;
  step: number; bootstrapMs: number; reused?: boolean; totals: Partial<Record<VerificationStage, number>>;
};
type Completion = { requestedCount: number; candidatesChecked: number; graphBatchRequests: number; verificationDurationMs: number; status: "ready" | "failed" };
type Context = { trace: VerificationTrace; stages: Partial<Record<VerificationStage, { durationMs: number; count: number; cumulativeMs: number }>>; completion?: Completion };
const context = new AsyncLocalStorage<Context>();
export const verificationIdHeader = "X-Outlook-Verification-Id";
export function validVerificationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function newVerificationTrace(correlationId: string = randomUUID()): VerificationTrace {
  return { correlationId, receivedAt: Date.now(), step: 0, bootstrapMs: 0, totals: {} };
}
export function currentVerificationTrace() { return context.getStore()?.trace; }
export function verificationCompleted(input: Completion) { const active = context.getStore(); if (active) active.completion = input; }
export function logCompletedVerification() { const active = context.getStore(); if (active?.completion) logVerificationSummary(active.trace, active.completion); }
function safeLog(label: string, value: object) {
  try { console.info(label, value); } catch { /* Telemetry cannot change execution. */ }
}
export function logVerificationRequestFailure(reason: "invalid_count" | "request_failed", input: {
  action: "start" | "status"; requestedCount?: unknown; error?: unknown;
}) {
  const trace = currentVerificationTrace();
  safeLog("Outlook verification request failed", {
    ...(trace ? { correlationId: trace.correlationId } : {}),
    action: input.action, reason,
    ...(typeof input.requestedCount === "number" && Number.isSafeInteger(input.requestedCount) && input.requestedCount > 0
      ? { requestedCount: input.requestedCount } : {}),
    ...(reason === "request_failed" ? persistenceErrorDiagnostic(input.error) : {})
  });
}
function record(stage: VerificationStage, durationMs: number) {
  const active = context.getStore();
  if (!active) return;
  const span = active.stages[stage] ??= { durationMs: 0, count: 0, cumulativeMs: 0 };
  span.durationMs += durationMs; span.count++;
  span.cumulativeMs = Math.max(0, Date.now() - active.trace.receivedAt);
  active.trace.totals[stage] = (active.trace.totals[stage] ?? 0) + durationMs;
}
export async function measureVerification<T>(stage: VerificationStage, run: () => PromiseLike<T>): Promise<T> {
  if (!context.getStore()) return await run();
  const started = performance.now();
  try { return await run(); } finally { record(stage, performance.now() - started); }
}
export function measureVerificationSync<T>(stage: VerificationStage, run: () => T): T {
  if (!context.getStore()) return run();
  const started = performance.now();
  try { return run(); } finally { record(stage, performance.now() - started); }
}
export function verificationWorkflowSeed(): VerificationTrace | undefined {
  const trace = currentVerificationTrace();
  if (!trace) return;
  return structuredClone({ ...trace, scheduledAt: Date.now(), bootstrapMs: Date.now() - trace.receivedAt });
}
export async function withVerificationTrace<T>(trace: VerificationTrace, run: () => Promise<T>, unit?: "status"): Promise<T> {
  return context.run({ trace, stages: {} }, async () => {
    try { return await run(); }
    finally {
      const active = context.getStore()!;
      for (const [stage, span] of Object.entries(active.stages)) safeLog("Outlook verification timing", {
        correlationId: trace.correlationId, unit: unit ?? (trace.step ? "worker" : "start"), step: trace.step, stage,
        durationMs: Math.round(span.durationMs), count: span.count, cumulativeMs: span.cumulativeMs
      });
    }
  });
}
export function recordWorkflowArrival(trace: VerificationTrace) {
  trace.step++;
  record(trace.lastStepEndedAt === undefined ? "workflow_startup" : "workflow_gap",
    Math.max(0, Date.now() - (trace.lastStepEndedAt ?? trace.scheduledAt ?? Date.now())));
}
export function logVerificationSummary(trace: VerificationTrace, input: {
  requestedCount: number; candidatesChecked: number; graphBatchRequests: number; verificationDurationMs: number;
  status: "ready" | "failed";
}) {
  const t = trace.totals;
  const serverTotalMs = Math.max(0, Date.now() - trace.receivedAt);
  safeLog("Outlook verification end-to-end", {
    correlationId: trace.correlationId, ...input, reused: trace.reused === true, steps: trace.step, serverTotalMs,
    verificationBatchesPerStep: outlookVerificationBatchesPerStep, verificationStepBudgetMs: outlookVerificationStepBudgetMs,
    graphDurationMs: Math.round(t.targeted_graph ?? 0),
    workflowStartupMs: Math.round(t.workflow_startup ?? 0), workflowGapMs: Math.round(t.workflow_gap ?? 0),
    workerMs: Math.round(t.worker_unit ?? 0), bootstrapMs: Math.round(trace.bootstrapMs),
    databaseMs: Math.round((t.database_read ?? 0) + (t.database_write ?? 0)), databaseCoverage: "instrumented_repository_calls",
    persistenceMs: Math.round(t.job_persistence ?? 0),
    credentialMs: Math.round(t.credentials ?? 0), authorizationMs: Math.round(t.authorization ?? 0),
    tokenRefreshMs: Math.round(t.token_refresh ?? 0), headerNormalizationMs: Math.round(t.header_normalization ?? 0),
    creditEntitlementMs: Math.round(t.credit_entitlement ?? 0),
    decryptDeserializeMs: Math.round(t.decrypt_deserialize ?? 0), encryptSerializeMs: Math.round(t.encrypt_serialize ?? 0),
    safetyEvaluationMs: Math.round(t.safety_evaluation ?? 0), providerCoordinationMs: Math.round(t.provider_coordination ?? 0),
    wallResidualMs: Math.round(serverTotalMs - trace.bootstrapMs - (t.worker_unit ?? 0) - (t.workflow_startup ?? 0) - (t.workflow_gap ?? 0))
  });
}
