-- AlterTable: replace string columns with FK references
ALTER TABLE "Client" DROP COLUMN IF EXISTS "city";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "country";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "county";

ALTER TABLE "Client" ADD COLUMN "countryId" INTEGER;
ALTER TABLE "Client" ADD COLUMN "stateId" INTEGER;
ALTER TABLE "Client" ADD COLUMN "cityId" INTEGER;

-- CreateIndex
CREATE INDEX "Client_countryId_idx" ON "Client"("countryId");
CREATE INDEX "Client_stateId_idx" ON "Client"("stateId");
CREATE INDEX "Client_cityId_idx" ON "Client"("cityId");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Client" ADD CONSTRAINT "Client_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Client" ADD CONSTRAINT "Client_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;
