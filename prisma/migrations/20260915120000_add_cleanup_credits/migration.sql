-- AlterTable
ALTER TABLE "User" ADD COLUMN     "creditOwnerId" TEXT;
CREATE INDEX "User_creditOwnerId_idx" ON "User"("creditOwnerId");

-- AlterTable
ALTER TABLE "BillingAccount" ADD COLUMN     "creditBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pack" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "stripeSessionId" TEXT,
    "stripePaymentId" TEXT,
    "credits" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "granted" INTEGER NOT NULL DEFAULT 0,
    "reversed" INTEGER NOT NULL DEFAULT 0,
    "livemode" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditJobAccounting" (
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeStateJobId" TEXT,
    "requested" INTEGER NOT NULL,
    "moved" INTEGER NOT NULL DEFAULT 0,
    "restored" INTEGER NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CreditJobAccounting_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "CreditEntry" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditEntry_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "InboxLinkIntent" (
    "id" TEXT NOT NULL,
    "sourceUserId" TEXT NOT NULL,
    "sourceConnectionId" TEXT NOT NULL,
    "sourceGeneration" TEXT NOT NULL,
    "provider" "EmailProviderName" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "InboxLinkIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_stripeSessionId_key" ON "CreditPurchase"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_stripePaymentId_key" ON "CreditPurchase"("stripePaymentId");

-- CreateIndex
CREATE INDEX "CreditPurchase_userId_status_idx" ON "CreditPurchase"("userId", "status");

-- Survives process replacement or lease expiry between lookup and creation.
CREATE UNIQUE INDEX "CreditPurchase_one_pending_per_account" ON "CreditPurchase"("userId") WHERE "status" = 'pending';

ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_amounts_check"
CHECK ("credits" > 0 AND "amountCents" > 0 AND "granted" >= 0 AND "granted" <= "credits" AND "reversed" >= 0 AND "reversed" <= "granted");

ALTER TABLE "CreditJobAccounting" ADD CONSTRAINT "CreditJobAccounting_counts_check"
CHECK ("requested" > 0 AND "moved" >= 0 AND "moved" <= "requested" AND "restored" >= 0 AND "restored" <= "moved");

-- CreateIndex
CREATE UNIQUE INDEX "CreditJobAccounting_activeStateJobId_key" ON "CreditJobAccounting"("activeStateJobId");

-- CreateIndex
CREATE INDEX "CreditJobAccounting_userId_closed_idx" ON "CreditJobAccounting"("userId", "closed");

-- CreateIndex
CREATE INDEX "CreditEntry_userId_createdAt_idx" ON "CreditEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "InboxLinkIntent_expiresAt_idx" ON "InboxLinkIntent"("expiresAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_creditOwnerId_fkey" FOREIGN KEY ("creditOwnerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPurchase" ADD CONSTRAINT "CreditPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "BillingAccount"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditJobAccounting" ADD CONSTRAINT "CreditJobAccounting_activeStateJobId_fkey" FOREIGN KEY ("activeStateJobId") REFERENCES "CleanupJobState"("jobId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditJobAccounting" ADD CONSTRAINT "CreditJobAccounting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "BillingAccount"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "BillingAccount"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
