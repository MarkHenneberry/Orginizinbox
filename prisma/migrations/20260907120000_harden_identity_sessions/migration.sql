BEGIN;

ALTER TABLE "User" ADD COLUMN "microsoftIdentityHash" TEXT;
ALTER TABLE "ProviderConnection" ADD COLUMN "sessionGeneration" TEXT;

-- Recover only identity evidence already verified by Microsoft, never email matches.
UPDATE "User" AS account
SET "microsoftIdentityHash" = connection."mailboxExternalIdHash"
FROM "ProviderConnection" AS connection
WHERE connection."userId" = account."id"
  AND connection."provider" = 'microsoft'
  AND connection."mailboxExternalIdHash" IS NOT NULL;

-- Ambiguous historical ownership must fail rather than silently merge accounts.
CREATE UNIQUE INDEX "User_microsoftIdentityHash_key" ON "User"("microsoftIdentityHash");

COMMIT;
