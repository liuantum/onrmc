-- CreateTable
CREATE TABLE "CubeSet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "fck" DECIMAL(5,1) NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,
    "slumpMm" INTEGER,
    "tempC" DECIMAL(4,1),
    "cubeSizeMm" INTEGER NOT NULL DEFAULT 150,
    "sampledById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CubeSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CubeResult" (
    "id" TEXT NOT NULL,
    "cubeSetId" TEXT NOT NULL,
    "ageDays" INTEGER NOT NULL,
    "testedAt" TIMESTAMP(3) NOT NULL,
    "cubeNo" INTEGER NOT NULL,
    "weightKg" DECIMAL(6,3),
    "loadKn" DECIMAL(8,1) NOT NULL,
    "strengthMpa" DECIMAL(6,2) NOT NULL,
    "testedById" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CubeResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CubeSet_tenantId_sampledAt_idx" ON "CubeSet"("tenantId", "sampledAt");

-- CreateIndex
CREATE UNIQUE INDEX "CubeSet_tenantId_number_key" ON "CubeSet"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CubeResult_cubeSetId_ageDays_cubeNo_key" ON "CubeResult"("cubeSetId", "ageDays", "cubeNo");

-- AddForeignKey
ALTER TABLE "CubeSet" ADD CONSTRAINT "CubeSet_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CubeResult" ADD CONSTRAINT "CubeResult_cubeSetId_fkey" FOREIGN KEY ("cubeSetId") REFERENCES "CubeSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
