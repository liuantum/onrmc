-- Separate migration: a new enum value can't be used in the transaction that adds it
ALTER TABLE "EinvoiceSettings" ALTER COLUMN "provider" SET DEFAULT 'PORTAL';
