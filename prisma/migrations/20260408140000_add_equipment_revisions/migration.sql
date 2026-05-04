-- CreateTable
CREATE TABLE "EquipmentRevision" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "revisionDate" TIMESTAMP(3) NOT NULL,
    "s3Key" TEXT,
    "fileName" TEXT,
    "operatorName" TEXT,
    "operatorAddress" TEXT,
    "operatorPhone" TEXT,
    "operatorEmail" TEXT,
    "analyzerName" TEXT,
    "analyzerSerial" TEXT,
    "analysisData" JSONB,
    "rawText" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquipmentRevision_equipmentId_idx" ON "EquipmentRevision"("equipmentId");

-- CreateIndex
CREATE INDEX "EquipmentRevision_equipmentId_revisionDate_idx" ON "EquipmentRevision"("equipmentId", "revisionDate");

-- AddForeignKey
ALTER TABLE "EquipmentRevision" ADD CONSTRAINT "EquipmentRevision_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
