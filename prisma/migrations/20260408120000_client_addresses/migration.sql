-- CreateTable
CREATE TABLE "ClientAddress" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "label" TEXT,
    "address" TEXT NOT NULL,
    "countryId" INTEGER,
    "stateId" INTEGER,
    "cityId" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientAddress_clientId_idx" ON "ClientAddress"("clientId");
CREATE INDEX "ClientAddress_countryId_idx" ON "ClientAddress"("countryId");
CREATE INDEX "ClientAddress_stateId_idx" ON "ClientAddress"("stateId");
CREATE INDEX "ClientAddress_cityId_idx" ON "ClientAddress"("cityId");

-- AddForeignKey
ALTER TABLE "ClientAddress" ADD CONSTRAINT "ClientAddress_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientAddress" ADD CONSTRAINT "ClientAddress_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClientAddress" ADD CONSTRAINT "ClientAddress_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClientAddress" ADD CONSTRAINT "ClientAddress_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Migrate existing client addresses to ClientAddress table
INSERT INTO "ClientAddress" ("id", "clientId", "address", "countryId", "stateId", "cityId", "isPrimary", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", "address", "countryId", "stateId", "cityId", true, NOW(), NOW()
FROM "Client"
WHERE "address" IS NOT NULL AND "address" != '';

-- Add clientAddressId to Equipment
ALTER TABLE "Equipment" ADD COLUMN "clientAddressId" TEXT;
CREATE INDEX "Equipment_clientAddressId_idx" ON "Equipment"("clientAddressId");
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_clientAddressId_fkey" FOREIGN KEY ("clientAddressId") REFERENCES "ClientAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Link existing equipment to the primary address of their client
UPDATE "Equipment" e
SET "clientAddressId" = ca."id"
FROM "ClientAddress" ca
WHERE ca."clientId" = e."clientId" AND ca."isPrimary" = true;

-- Drop old columns from Client
ALTER TABLE "Client" DROP CONSTRAINT IF EXISTS "Client_countryId_fkey";
ALTER TABLE "Client" DROP CONSTRAINT IF EXISTS "Client_stateId_fkey";
ALTER TABLE "Client" DROP CONSTRAINT IF EXISTS "Client_cityId_fkey";
DROP INDEX IF EXISTS "Client_countryId_idx";
DROP INDEX IF EXISTS "Client_stateId_idx";
DROP INDEX IF EXISTS "Client_cityId_idx";
ALTER TABLE "Client" DROP COLUMN "address";
ALTER TABLE "Client" DROP COLUMN "countryId";
ALTER TABLE "Client" DROP COLUMN "stateId";
ALTER TABLE "Client" DROP COLUMN "cityId";
