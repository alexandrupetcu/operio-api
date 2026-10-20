-- AlterTable
ALTER TABLE "DocumentTemplate" ADD COLUMN     "distributorCode" TEXT;


-- Grupurile de sistem existente: distribuitorul era doar în nume.
UPDATE "DocumentTemplate" SET "distributorCode" = 'DISTRIGAZ'     WHERE "type" = 'group' AND "name" ILIKE '%distrigaz%';
UPDATE "DocumentTemplate" SET "distributorCode" = 'MEGACONSTRUCT' WHERE "type" = 'group' AND "name" ILIKE '%megaconstruct%';
UPDATE "DocumentTemplate" SET "distributorCode" = 'NEOGAS_GRID'   WHERE "type" = 'group' AND "name" ILIKE '%neogas%';
