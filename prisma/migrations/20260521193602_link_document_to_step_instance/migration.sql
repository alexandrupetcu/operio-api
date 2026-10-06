-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "workflowStepInstanceId" TEXT;

-- CreateIndex
CREATE INDEX "Document_tenantId_workflowStepInstanceId_idx" ON "Document"("tenantId", "workflowStepInstanceId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_workflowStepInstanceId_fkey" FOREIGN KEY ("workflowStepInstanceId") REFERENCES "WorkflowStepInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
