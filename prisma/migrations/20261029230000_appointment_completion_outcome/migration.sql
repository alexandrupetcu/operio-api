-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "completionOutcome" TEXT;


-- Vizitele finalizate cu raport: au în completionDataJson și altceva decât cheile tehnice („_…”).
UPDATE "Appointment" a SET "completionOutcome" = 'raport_complet'
WHERE a."status" = 'completed'
  AND jsonb_typeof(a."completionDataJson"::jsonb) = 'object'
  AND EXISTS (SELECT 1 FROM jsonb_object_keys(a."completionDataJson"::jsonb) k WHERE k NOT LIKE '\_%');

-- Finalizate fără raport (revenire / programare nouă): rezultatul e în istoricul finalizării.
UPDATE "Appointment" a SET "completionOutcome" = l."afterJson"->>'outcome'
FROM "AuditLog" l
WHERE a."completionOutcome" IS NULL
  AND a."status" = 'completed'
  AND l."entityType" = 'appointment' AND l."entityId" = a."id" AND l."action" = 'finalize'
  AND l."afterJson"->>'outcome' IN ('revenire', 'programare_noua');
