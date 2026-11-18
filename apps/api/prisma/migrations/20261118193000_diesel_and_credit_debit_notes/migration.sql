-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "NoteReason" AS ENUM ('RATE_DIFFERENCE', 'QUANTITY_RETURNED', 'SHORT_SUPPLY', 'POST_SUPPLY_DISCOUNT', 'IRN_CANCELLED_AFTER_24H');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "noteAdj" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditDebitNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "NoteType" NOT NULL,
    "number" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "reason" "NoteReason" NOT NULL,
    "reasonText" TEXT,
    "quantityBased" BOOLEAN NOT NULL DEFAULT false,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placeOfSupply" TEXT NOT NULL,
    "interState" BOOLEAN NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "applied" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "NoteStatus" NOT NULL DEFAULT 'ISSUED',
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "einvoiceStatus" "EinvoiceStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "irn" TEXT,
    "ackNo" TEXT,
    "ackDate" TIMESTAMP(3),
    "signedQr" TEXT,
    "signedInvoice" TEXT,
    "einvoiceError" TEXT,
    "irnCancelledAt" TIMESTAMP(3),
    "irnCancelReason" TEXT,

    CONSTRAINT "CreditDebitNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteLine" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "invoiceLineId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "hsn" TEXT NOT NULL,
    "quantity" DECIMAL(10,2),
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "NoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditDebitNote_irn_key" ON "CreditDebitNote"("irn");

-- CreateIndex
CREATE INDEX "CreditDebitNote_tenantId_invoiceId_idx" ON "CreditDebitNote"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditDebitNote_tenantId_number_key" ON "CreditDebitNote"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "CreditDebitNote" ADD CONSTRAINT "CreditDebitNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditDebitNote" ADD CONSTRAINT "CreditDebitNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditDebitNote" ADD CONSTRAINT "CreditDebitNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteLine" ADD CONSTRAINT "NoteLine_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "CreditDebitNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteLine" ADD CONSTRAINT "NoteLine_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────── Data ─────────

-- Diesel / Fuel expense (5100) and Sales returns & discounts (4900) for every tenant with a chart of accounts.
UPDATE "Account" SET "name" = 'Diesel / Fuel expense' WHERE "code" = '5100' AND "system" = true;
INSERT INTO "Account" ("id", "tenantId", "code", "name", "type", "group", "system")
SELECT 'acc5100_' || t."id", t."id", '5100', 'Diesel / Fuel expense', 'EXPENSE', 'Direct Expenses', true FROM "Tenant" t
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '1100')
  AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '5100');
INSERT INTO "Account" ("id", "tenantId", "code", "name", "type", "group", "system")
SELECT 'acc4900_' || t."id", t."id", '4900', 'Sales returns & discounts', 'INCOME', 'Sales Accounts', true FROM "Tenant" t
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '1100')
  AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '4900');

-- Backfill: Dr Diesel / Fuel expense, Cr Cash for diesel already recorded on challans (not cancelled, not yet posted).
CREATE TEMP TABLE _diesel AS
SELECT c."id", c."tenantId", c."number", COALESCE(c."deliveredAt", c."createdAt") AS dt, c."dieselCost" AS amt
FROM "Challan" c
WHERE c."dieselCost" > 0 AND c."status" <> 'CANCELLED'
  AND NOT EXISTS (SELECT 1 FROM "Journal" j WHERE j."sourceType" IN ('CHALLAN_DIESEL', 'CHALLAN_DIESEL_REV') AND j."sourceId" = c."id");

INSERT INTO "Journal" ("id", "tenantId", "date", "narration", "sourceType", "sourceId")
SELECT 'jdsl_' || d."id", d."tenantId", d.dt, 'Diesel ' || d."number", 'CHALLAN_DIESEL', d."id" FROM _diesel d;

INSERT INTO "JournalEntry" ("id", "journalId", "accountId", "debit", "credit")
SELECT 'jedd_' || d."id", 'jdsl_' || d."id", a."id", d.amt, 0 FROM _diesel d JOIN "Account" a ON a."tenantId" = d."tenantId" AND a."code" = '5100'
UNION ALL
SELECT 'jedc_' || d."id", 'jdsl_' || d."id", a."id", 0, d.amt FROM _diesel d JOIN "Account" a ON a."tenantId" = d."tenantId" AND a."code" = '1100';

DROP TABLE _diesel;
