-- CreateEnum
CREATE TYPE "EinvoiceStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'GENERATED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "GspProvider" AS ENUM ('MOCK', 'CLEARTAX', 'MASTERS_INDIA', 'NIC_DIRECT');

-- CreateEnum
CREATE TYPE "EwayBillStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "city" TEXT,
ADD COLUMN     "pincode" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "ackDate" TIMESTAMP(3),
ADD COLUMN     "ackNo" TEXT,
ADD COLUMN     "einvoiceError" TEXT,
ADD COLUMN     "einvoiceStatus" "EinvoiceStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "irn" TEXT,
ADD COLUMN     "irnCancelReason" TEXT,
ADD COLUMN     "irnCancelledAt" TIMESTAMP(3),
ADD COLUMN     "signedInvoice" TEXT,
ADD COLUMN     "signedQr" TEXT;

-- AlterTable
ALTER TABLE "Plant" ADD COLUMN     "pincode" TEXT;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "city" TEXT,
ADD COLUMN     "pincode" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "city" TEXT,
ADD COLUMN     "pincode" TEXT;

-- CreateTable
CREATE TABLE "EinvoiceSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "einvoiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ewaybillEnabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" "GspProvider" NOT NULL DEFAULT 'MOCK',
    "credentialsEnc" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EinvoiceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EwayBill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "challanId" TEXT,
    "ewbNo" TEXT NOT NULL,
    "ewbDate" TIMESTAMP(3) NOT NULL,
    "validUpto" TIMESTAMP(3),
    "vehicleNo" TEXT,
    "transMode" TEXT NOT NULL DEFAULT '1',
    "distanceKm" INTEGER NOT NULL,
    "status" "EwayBillStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EwayBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EinvoiceSettings_tenantId_key" ON "EinvoiceSettings"("tenantId");

-- CreateIndex
CREATE INDEX "EwayBill_invoiceId_idx" ON "EwayBill"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "EwayBill_tenantId_ewbNo_key" ON "EwayBill"("tenantId", "ewbNo");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_irn_key" ON "Invoice"("irn");

-- AddForeignKey
ALTER TABLE "EinvoiceSettings" ADD CONSTRAINT "EinvoiceSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EwayBill" ADD CONSTRAINT "EwayBill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EwayBill" ADD CONSTRAINT "EwayBill_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EwayBill" ADD CONSTRAINT "EwayBill_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "Challan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

