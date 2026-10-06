-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "distributorId" TEXT;

-- AlterTable
ALTER TABLE "WorkflowDefinition" ADD COLUMN     "distributorId" TEXT,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'primary';

-- CreateTable
CREATE TABLE "Distributor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactJson" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Distributor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Distributor_tenantId_isActive_idx" ON "Distributor"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Distributor_tenantId_code_key" ON "Distributor"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Project_tenantId_distributorId_idx" ON "Project"("tenantId", "distributorId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_distributorId_idx" ON "WorkflowDefinition"("tenantId", "distributorId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_role_idx" ON "WorkflowDefinition"("tenantId", "role");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_role_projectTypeId_distributorI_idx" ON "WorkflowDefinition"("tenantId", "role", "projectTypeId", "distributorId");

-- AddForeignKey
ALTER TABLE "Distributor" ADD CONSTRAINT "Distributor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_distributorId_fkey" FOREIGN KEY ("distributorId") REFERENCES "Distributor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_distributorId_fkey" FOREIGN KEY ("distributorId") REFERENCES "Distributor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
