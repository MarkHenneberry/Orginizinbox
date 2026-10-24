CREATE TABLE "CleanupJobStateChunk" (
    "jobId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    CONSTRAINT "CleanupJobStateChunk_pkey" PRIMARY KEY ("jobId", "slot")
);

ALTER TABLE "CleanupJobStateChunk" ADD CONSTRAINT "CleanupJobStateChunk_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "CleanupJobState"("jobId") ON DELETE CASCADE ON UPDATE CASCADE;
