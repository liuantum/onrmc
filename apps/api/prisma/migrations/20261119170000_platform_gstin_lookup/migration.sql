-- Platform-wide GSTIN lookup through onrmc's Masters India account
ALTER TABLE "PlatformSettings" ADD COLUMN "gstinLookupEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformSettings" ADD COLUMN "gstinLookupGstin" TEXT;
ALTER TABLE "PlatformSettings" ADD COLUMN "gstinLookupEnc" TEXT;
