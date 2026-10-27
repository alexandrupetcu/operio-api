-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "createIdempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Client_tenantId_createIdempotencyKey_key" ON "Client"("tenantId", "createIdempotencyKey");

