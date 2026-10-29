-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "positions" TEXT[] DEFAULT ARRAY[]::TEXT[];


-- Funcția de până acum devine prima (și singura) din listă.
UPDATE "Employee" SET "positions" = ARRAY["position"] WHERE "position" IS NOT NULL AND "position" <> '';
