-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "cityId" INTEGER,
ADD COLUMN     "countryId" INTEGER,
ADD COLUMN     "stateId" INTEGER;

-- CreateIndex
CREATE INDEX "Tenant_countryId_idx" ON "Tenant"("countryId");

-- CreateIndex
CREATE INDEX "Tenant_stateId_idx" ON "Tenant"("stateId");

-- CreateIndex
CREATE INDEX "Tenant_cityId_idx" ON "Tenant"("cityId");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;
