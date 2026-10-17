-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "appointmentId" TEXT;

-- Backfill: documentele generate pentru o programare țin id-ul în contextJson.
-- Coloana e un duplicat indexabil; contextJson.appointmentId rămâne scris în continuare.
UPDATE "Document"
SET "appointmentId" = "contextJson"->>'appointmentId'
WHERE "appointmentId" IS NULL
  AND jsonb_typeof("contextJson"->'appointmentId') = 'string';

-- CreateIndex
CREATE INDEX "Client_tenantId_status_idx" ON "Client"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Document_tenantId_appointmentId_idx" ON "Document"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "EquipmentRevision_sourceEmailId_idx" ON "EquipmentRevision"("sourceEmailId");
