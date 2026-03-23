-- CreateEnum
CREATE TYPE "ActionTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'SKIPPED');

-- CreateTable
CREATE TABLE "WorkflowTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "projectType" "ProjectType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTemplateStep" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "institution" TEXT,
    "estimatedDays" INTEGER NOT NULL DEFAULT 30,
    "requiredDocuments" TEXT[],
    "dependsOnStepOrder" INTEGER,
    "isSelectable" BOOLEAN NOT NULL DEFAULT false,
    "isSelectedByDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTemplateStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "templateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionTask" (
    "id" TEXT NOT NULL,
    "actionPlanId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "institution" TEXT,
    "status" "ActionTaskStatus" NOT NULL DEFAULT 'TODO',
    "estimatedDays" INTEGER,
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "completedDate" TIMESTAMP(3),
    "notes" TEXT,
    "dependsOnTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowTemplate_tenantId_projectType_idx" ON "WorkflowTemplate"("tenantId", "projectType");

-- CreateIndex
CREATE INDEX "WorkflowTemplateStep_templateId_idx" ON "WorkflowTemplateStep"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionPlan_projectId_key" ON "ActionPlan"("projectId");

-- CreateIndex
CREATE INDEX "ActionPlan_tenantId_idx" ON "ActionPlan"("tenantId");

-- CreateIndex
CREATE INDEX "ActionTask_actionPlanId_idx" ON "ActionTask"("actionPlanId");

-- CreateIndex
CREATE INDEX "ActionTask_dueDate_idx" ON "ActionTask"("dueDate");

-- CreateIndex
CREATE INDEX "ActionTask_status_idx" ON "ActionTask"("status");

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplateStep" ADD CONSTRAINT "WorkflowTemplateStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionTask" ADD CONSTRAINT "ActionTask_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionTask" ADD CONSTRAINT "ActionTask_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "ActionTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
