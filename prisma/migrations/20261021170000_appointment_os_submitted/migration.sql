-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "osSubmittedAt" TIMESTAMP(3);


-- Ce are deja număr de la OS a fost, evident, depus.
UPDATE "Appointment" SET "osSubmittedAt" = "osRegisteredAt" WHERE "osRegistrationNumber" IS NOT NULL AND "osSubmittedAt" IS NULL;
