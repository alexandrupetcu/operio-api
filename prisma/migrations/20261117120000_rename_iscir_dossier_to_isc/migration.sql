-- Dosarul de șantier e pentru ISC (Inspectoratul de Stat în Construcții), nu ISCIR.
-- Doar denumirile se schimbă; codurile (DOSAR_ISCIR, dosar_iscir, date_tehnice_iscir) rămân.
-- Revizia de centrală (ISCIR) nu e atinsă.
UPDATE "DocumentTemplate" SET "name" = 'Dosar ISC'
  WHERE "type" = 'group' AND "name" = 'Dosar ISCIR Template';
UPDATE "TemplateCategory" SET "name" = 'Dosar ISC'
  WHERE "code" = 'DOSAR_ISCIR' AND "name" ILIKE '%ISCIR%';
UPDATE "ProjectType"
  SET "name" = 'Dosar ISC', "description" = 'Dosarul de șantier pentru ISC (Inspectoratul de Stat în Construcții)'
  WHERE "code" = 'dosar_iscir' AND "name" = 'Dosar ISCIR';
UPDATE "WorkflowStep" SET "name" = REPLACE("name", 'Dosar ISCIR', 'Dosar ISC')
  WHERE "name" LIKE '%Dosar ISCIR%';
UPDATE "WorkflowStep" SET "name" = 'Date tehnice ISC'
  WHERE "name" = 'Date tehnice ISCIR';
UPDATE "WorkflowDefinition" SET "description" = REPLACE("description", 'Dosar ISCIR', 'Dosar ISC')
  WHERE "description" LIKE '%Dosar ISCIR%';
-- Dosarele deja create poartă numele grupului („Dosar ISCIR Template — Ion Popescu”).
UPDATE "Project" SET "name" = REPLACE("name", 'Dosar ISCIR Template', 'Dosar ISC')
  WHERE "name" LIKE 'Dosar ISCIR Template%';
