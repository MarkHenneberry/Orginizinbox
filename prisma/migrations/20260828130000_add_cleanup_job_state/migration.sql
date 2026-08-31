-- CreateTable
CREATE TABLE "CleanupJobState" (
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lockOwner" TEXT,
    "lockExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleanupJobState_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX "CleanupJobState_userId_expiresAt_idx" ON "CleanupJobState"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "CleanupJobState_expiresAt_idx" ON "CleanupJobState"("expiresAt");

-- AddForeignKey
ALTER TABLE "CleanupJobState" ADD CONSTRAINT "CleanupJobState_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CleanupJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleanupJobState" ADD CONSTRAINT "CleanupJobState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
