-- AlterTable
ALTER TABLE "WorkflowDefinition" ADD COLUMN     "distributorCode" TEXT,
ADD COLUMN     "projectTypeCode" TEXT;

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_role_projectTypeCode_distributo_idx" ON "WorkflowDefinition"("tenantId", "role", "projectTypeCode", "distributorCode");


-- Workflow-urile de sistem existente primesc codurile din rândurile la care trimit (ale unei firme).
UPDATE "WorkflowDefinition" d SET "projectTypeCode" = p.code
  FROM "ProjectType" p WHERE d."tenantId" IS NULL AND d."projectTypeId" = p.id;
UPDATE "WorkflowDefinition" d SET "distributorCode" = x.code
  FROM "Distributor" x WHERE d."tenantId" IS NULL AND d."distributorId" = x.id;
