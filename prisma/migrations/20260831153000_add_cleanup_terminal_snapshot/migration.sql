ALTER TABLE "CleanupJob"
ADD COLUMN "terminalState" TEXT,
ADD COLUMN "terminalSnapshot" JSONB,
ADD COLUMN "terminalSnapshotVersion" INTEGER NOT NULL DEFAULT 0;
