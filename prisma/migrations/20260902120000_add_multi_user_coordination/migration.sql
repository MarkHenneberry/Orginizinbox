-- Enforce one durable provider identity per Organizinbox user.
CREATE UNIQUE INDEX "ProviderConnection_userId_provider_key"
ON "ProviderConnection"("userId", "provider");

ALTER TABLE "ProviderConnection"
ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "refreshLeaseOwner" TEXT,
ADD COLUMN "refreshLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "CleanupJob"
ADD COLUMN "acceptanceKey" TEXT;

CREATE UNIQUE INDEX "CleanupJob_scanId_acceptanceKey_key"
ON "CleanupJob"("scanId", "acceptanceKey");

CREATE TABLE "ScanState" (
  "userId" TEXT NOT NULL,
  "provider" "EmailProviderName" NOT NULL,
  "scanId" TEXT NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "status" "ScanStatus" NOT NULL DEFAULT 'pending',
  "encryptedPayload" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "lockOwner" TEXT,
  "lockExpiresAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ScanState_pkey" PRIMARY KEY ("userId", "provider")
);

CREATE UNIQUE INDEX "ScanState_scanId_key" ON "ScanState"("scanId");
CREATE INDEX "ScanState_expiresAt_idx" ON "ScanState"("expiresAt");

ALTER TABLE "ScanState"
ADD CONSTRAINT "ScanState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScanState"
ADD CONSTRAINT "ScanState_scanId_fkey"
FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScanState"
ADD CONSTRAINT "ScanState_providerConnectionId_fkey"
FOREIGN KEY ("providerConnectionId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderRequestLease" (
  "providerConnectionId" TEXT NOT NULL,
  "slot" INTEGER NOT NULL,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderRequestLease_pkey" PRIMARY KEY ("providerConnectionId", "slot")
);

CREATE INDEX "ProviderRequestLease_leaseExpiresAt_idx"
ON "ProviderRequestLease"("leaseExpiresAt");

ALTER TABLE "ProviderRequestLease"
ADD CONSTRAINT "ProviderRequestLease_providerConnectionId_fkey"
FOREIGN KEY ("providerConnectionId") REFERENCES "ProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
