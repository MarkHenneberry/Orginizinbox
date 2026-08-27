-- Store the provider login email encrypted for IMAP authentication.
ALTER TABLE "ProviderConnection" ADD COLUMN "encryptedAccountEmail" TEXT;
