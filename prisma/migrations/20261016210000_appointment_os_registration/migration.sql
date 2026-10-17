-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "osClientNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "osRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "osRegistrationNumber" TEXT;

-- CreateIndex
CREATE INDEX "Appointment_tenantId_type_status_completedAt_idx" ON "Appointment"("tenantId", "type", "status", "completedAt");


-- Fișele deja finalizate: considerăm data ultimei modificări drept data finalizării,
-- ca termenul de înregistrare la OS și registrul Anexa 6 să aibă o dată de referință.
UPDATE "Appointment" SET "completedAt" = "updatedAt" WHERE "status" = 'completed' AND "completedAt" IS NULL;
