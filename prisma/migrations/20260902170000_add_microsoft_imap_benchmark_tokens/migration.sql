ALTER TABLE "ProviderConnection"
ADD COLUMN "encryptedImapAccessToken" TEXT,
ADD COLUMN "encryptedImapRefreshToken" TEXT,
ADD COLUMN "imapTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "imapScope" TEXT;
