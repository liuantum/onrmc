-- CreateEnum
CREATE TYPE "SubscriptionPaymentMethod" AS ENUM ('MANUAL', 'RAZORPAY', 'CASHFREE');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('CREATED', 'PENDING_VERIFICATION', 'PAID', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "manualEnabled" BOOLEAN NOT NULL DEFAULT true,
    "upiId" TEXT,
    "upiQr" TEXT,
    "bankAccountName" TEXT,
    "bankAccountNo" TEXT,
    "bankIfsc" TEXT,
    "bankName" TEXT,
    "bankBranch" TEXT,
    "instructions" TEXT,
    "razorpayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "razorpayKeyId" TEXT,
    "razorpaySecretEnc" TEXT,
    "razorpayWebhookEnc" TEXT,
    "cashfreeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cashfreeEnv" TEXT NOT NULL DEFAULT 'sandbox',
    "cashfreeAppId" TEXT,
    "cashfreeSecretEnc" TEXT,
    "cashfreeWebhookEnc" TEXT,
    "sellerLegalName" TEXT NOT NULL DEFAULT 'onrmc Technologies Pvt Ltd',
    "sellerGstin" TEXT,
    "sellerStateCode" TEXT NOT NULL DEFAULT '36',
    "sellerAddress" TEXT,
    "sellerPincode" TEXT,
    "sacCode" TEXT NOT NULL DEFAULT '998314',
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "reminderDays" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "billingCycle" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "taxable" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "method" "SubscriptionPaymentMethod" NOT NULL,
    "status" "SubscriptionPaymentStatus" NOT NULL,
    "reference" TEXT,
    "paidOn" TIMESTAMP(3),
    "screenshot" TEXT,
    "rejectReason" TEXT,
    "gatewayOrderId" TEXT,
    "gatewayPaymentId" TEXT,
    "raw" JSONB,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "submittedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seller" JSONB NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerGstin" TEXT,
    "buyerStateCode" TEXT NOT NULL,
    "buyerAddress" TEXT,
    "placeOfSupply" TEXT NOT NULL,
    "interState" BOOLEAN NOT NULL,
    "description" TEXT NOT NULL,
    "sac" TEXT NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "taxable" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSeries" (
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PlatformSeries_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_gatewayOrderId_key" ON "SubscriptionPayment"("gatewayOrderId");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_status_idx" ON "SubscriptionPayment"("status");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_tenantId_idx" ON "SubscriptionPayment"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_number_key" ON "SubscriptionInvoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_paymentId_key" ON "SubscriptionInvoice"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SubscriptionPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "PlatformSettings" ("id", "updatedAt") VALUES ('platform', now()) ON CONFLICT DO NOTHING;
