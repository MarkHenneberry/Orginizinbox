import type { InboxReport } from "@/lib/domain/types";

export function sanitizeReportForClient(
  report: InboxReport,
  includeDiagnostics = process.env.NODE_ENV !== "production"
): InboxReport {
  return {
    ...report,
    classifierDiagnostics: includeDiagnostics ? report.classifierDiagnostics : undefined,
    senders: report.senders.map((sender, index) => ({
      ...sender,
      senderKey: `sender-${index + 1}`,
      senderSecondaryLabel: sender.domain,
      diagnosticSenderIdentity: includeDiagnostics ? sender.senderKey : undefined,
      diagnostics: includeDiagnostics ? sender.diagnostics : undefined
    }))
  };
}
