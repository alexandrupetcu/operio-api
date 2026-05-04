-- AlterTable
ALTER TABLE "WorkflowDefinition" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "WorkflowInstance" ADD COLUMN     "parentStepInstanceId" TEXT,
ADD COLUMN     "parentWorkflowInstanceId" TEXT;

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_category_idx" ON "WorkflowDefinition"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_parentStepInstanceId_key" ON "WorkflowInstance"("parentStepInstanceId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_parentWorkflowInstanceId_idx" ON "WorkflowInstance"("parentWorkflowInstanceId");

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_parentStepInstanceId_fkey" FOREIGN KEY ("parentStepInstanceId") REFERENCES "WorkflowStepInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_parentWorkflowInstanceId_fkey" FOREIGN KEY ("parentWorkflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
