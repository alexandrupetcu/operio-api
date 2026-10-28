-- „Revizie Centrală” nu mai e tip de proiect: reviziile se fac din Programări / Revizii.
-- Se șterg workflow-urile lui fără nicio rulare, apoi tipul, unde nu-l mai folosește nimic
-- (proiect sau workflow cu rulări rămân, cu tipul lor).
DELETE FROM "WorkflowDefinition" d
USING "ProjectType" p
WHERE d."projectTypeId" = p."id" AND p."code" = 'revizie_centrala'
  AND NOT EXISTS (SELECT 1 FROM "WorkflowInstance" i WHERE i."workflowDefinitionId" = d."id");

DELETE FROM "WorkflowDefinition"
WHERE "tenantId" IS NULL AND "projectTypeCode" = 'revizie_centrala'
  AND NOT EXISTS (SELECT 1 FROM "WorkflowInstance" i WHERE i."workflowDefinitionId" = "WorkflowDefinition"."id");

DELETE FROM "ProjectType" p
WHERE p."code" = 'revizie_centrala'
  AND NOT EXISTS (SELECT 1 FROM "Project" x WHERE x."projectTypeId" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "WorkflowDefinition" d WHERE d."projectTypeId" = p."id");
