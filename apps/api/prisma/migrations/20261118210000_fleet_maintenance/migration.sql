-- CreateEnum
CREATE TYPE "MaintenancePaidVia" AS ENUM ('CASH', 'BANK', 'PURCHASE_BILL');

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "odometerKm" INTEGER;

-- CreateTable
CREATE TABLE "MaintenanceSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "everyKm" INTEGER,
    "everyDays" INTEGER,
    "lastDoneAt" TIMESTAMP(3),
    "lastDoneKm" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "odometerKm" INTEGER,
    "description" TEXT NOT NULL,
    "vendor" TEXT,
    "partsCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "labourCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "paidVia" "MaintenancePaidVia" NOT NULL,
    "billRef" TEXT,
    "downtimeHrs" DECIMAL(6,1),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "MaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaintenanceSchedule_tenantId_vehicleId_idx" ON "MaintenanceSchedule"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_tenantId_vehicleId_date_idx" ON "MaintenanceRecord"("tenantId", "vehicleId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRecord_tenantId_number_key" ON "MaintenanceRecord"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "MaintenanceSchedule" ADD CONSTRAINT "MaintenanceSchedule_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MaintenanceSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vehicle repairs account for existing tenants
INSERT INTO "Account" ("id", "tenantId", "code", "name", "type", "group", "system")
SELECT 'acc5310_' || t."id", t."id", '5310', 'Vehicle repairs & maintenance', 'EXPENSE', 'Indirect Expenses', true FROM "Tenant" t
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '1100')
  AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '5310');
