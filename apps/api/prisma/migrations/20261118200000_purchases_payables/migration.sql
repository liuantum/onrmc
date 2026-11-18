-- CreateEnum
CREATE TYPE "PurchaseBillKind" AS ENUM ('MATERIAL', 'EXPENSE');

-- CreateEnum
CREATE TYPE "PurchaseBillStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierNoteReason" AS ENUM ('SHORT_SUPPLY', 'RATE_DIFFERENCE', 'OTHER');

-- AlterTable
ALTER TABLE "MaterialReceipt" ADD COLUMN     "billId" TEXT,
ADD COLUMN     "legacyPosted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "address" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "rcmDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stateCode" TEXT;

-- CreateTable
CREATE TABLE "PurchaseBill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierBillNo" TEXT NOT NULL,
    "billDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "kind" "PurchaseBillKind" NOT NULL,
    "interState" BOOLEAN NOT NULL,
    "rcm" BOOLEAN NOT NULL DEFAULT false,
    "taxable" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "tdsSection" TEXT,
    "tdsRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tdsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tcsAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payable" DECIMAL(14,2) NOT NULL,
    "paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "debitNoted" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "PurchaseBillStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseBillLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "materialId" TEXT,
    "expenseAccountId" TEXT,
    "description" TEXT NOT NULL,
    "hsn" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "grnQty" DECIMAL(14,3),
    "grnValue" DECIMAL(14,2),
    "inventoryAdj" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "claimQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "claimValue" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseBillLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPaymentAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "SupplierPaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDebitNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "reason" "SupplierNoteReason" NOT NULL,
    "reasonText" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taxable" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "applied" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "NoteStatus" NOT NULL DEFAULT 'ISSUED',
    "cancelReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierDebitNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDebitNoteLine" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "billLineId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3),
    "rate" DECIMAL(14,4) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "SupplierDebitNoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseBill_tenantId_supplierId_status_idx" ON "PurchaseBill"("tenantId", "supplierId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_tenantId_number_key" ON "PurchaseBill"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_tenantId_supplierId_supplierBillNo_key" ON "PurchaseBill"("tenantId", "supplierId", "supplierBillNo");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_tenantId_number_key" ON "SupplierPayment"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDebitNote_tenantId_number_key" ON "SupplierDebitNote"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "MaterialReceipt" ADD CONSTRAINT "MaterialReceipt_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBill" ADD CONSTRAINT "PurchaseBill_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBillLine" ADD CONSTRAINT "PurchaseBillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseBillLine" ADD CONSTRAINT "PurchaseBillLine_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SupplierPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT "SupplierPaymentAllocation_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierDebitNote" ADD CONSTRAINT "SupplierDebitNote_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierDebitNote" ADD CONSTRAINT "SupplierDebitNote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierDebitNoteLine" ADD CONSTRAINT "SupplierDebitNoteLine_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "SupplierDebitNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierDebitNoteLine" ADD CONSTRAINT "SupplierDebitNoteLine_billLineId_fkey" FOREIGN KEY ("billLineId") REFERENCES "PurchaseBillLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────── Data ─────────
-- New system accounts for payables.
INSERT INTO "Account" ("id", "tenantId", "code", "name", "type", "group", "system")
SELECT 'acc' || x.code || '_' || t."id", t."id", x.code, x.name, x.type::"AccountType", x.grp, true
FROM "Tenant" t
CROSS JOIN (VALUES
  ('1520', 'TCS receivable', 'ASSET', 'Duties & Taxes'),
  ('1530', 'Supplier claims (short supply)', 'ASSET', 'Loans & Advances'),
  ('2150', 'Goods received, not billed', 'LIABILITY', 'Current Liabilities'),
  ('2230', 'GST payable on reverse charge', 'LIABILITY', 'Duties & Taxes'),
  ('2300', 'TDS payable', 'LIABILITY', 'Duties & Taxes')
) AS x(code, name, type, grp)
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '1100')
  AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = x.code);

-- Receipts recorded before purchase bills existed already credited the supplier: never bill them again.
UPDATE "MaterialReceipt" SET "legacyPosted" = true;

-- Supplier state from the GSTIN where it is known.
UPDATE "Supplier" SET "stateCode" = LEFT("gstin", 2) WHERE "stateCode" IS NULL AND "gstin" ~ '^[0-9]{2}';
