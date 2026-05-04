/*
  Warnings:

  - You are about to drop the column `type` on the `Project` table. All the data in the column will be lost.
  - The `status` column on the `Project` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `ActionPlan` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ActionTask` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WorkflowTemplate` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WorkflowTemplateStep` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `projectTypeId` to the `Project` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ActionPlan" DROP CONSTRAINT "ActionPlan_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ActionPlan" DROP CONSTRAINT "ActionPlan_templateId_fkey";

-- DropForeignKey
ALTER TABLE "ActionPlan" DROP CONSTRAINT "ActionPlan_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "ActionTask" DROP CONSTRAINT "ActionTask_actionPlanId_fkey";

-- DropForeignKey
ALTER TABLE "ActionTask" DROP CONSTRAINT "ActionTask_dependsOnTaskId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowTemplate" DROP CONSTRAINT "WorkflowTemplate_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowTemplateStep" DROP CONSTRAINT "WorkflowTemplateStep_templateId_fkey";

-- AlterTable
ALTER TABLE "Project" DROP COLUMN "type",
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "currentWorkflowInstanceId" TEXT,
ADD COLUMN     "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN     "projectTypeId" TEXT NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'draft';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "brandingJson" JSONB,
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'ro',
ADD COLUMN     "settingsJson" JSONB,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Bucharest';

-- DropTable
DROP TABLE "ActionPlan";

-- DropTable
DROP TABLE "ActionTask";

-- DropTable
DROP TABLE "WorkflowTemplate";

-- DropTable
DROP TABLE "WorkflowTemplateStep";

-- DropEnum
DROP TYPE "ActionTaskStatus";

-- DropEnum
DROP TYPE "ProjectStatus";

-- DropEnum
DROP TYPE "ProjectType";

-- CreateTable
CREATE TABLE "ProjectType" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "baseDefinitionId" TEXT,
    "projectTypeId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entityType" TEXT NOT NULL DEFAULT 'project',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "configJson" JSONB,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "workflowDefinitionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stepType" TEXT NOT NULL DEFAULT 'human_task',
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "isStart" BOOLEAN NOT NULL DEFAULT false,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "configJson" JSONB,
    "formSchemaJson" JSONB,
    "validationSchemaJson" JSONB,
    "uiSchemaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTransition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "workflowDefinitionId" TEXT NOT NULL,
    "fromStepId" TEXT NOT NULL,
    "toStepId" TEXT NOT NULL,
    "transitionType" TEXT NOT NULL DEFAULT 'default',
    "label" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditionJson" JSONB,
    "configJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStepAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "stepId" TEXT NOT NULL,
    "triggerEvent" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionConfigJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowStepAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowDefinitionId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL DEFAULT 'project',
    "entityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "currentStepCode" TEXT,
    "contextJson" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStepInstance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "stepDefinitionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "availableAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "assignedUserId" TEXT,
    "outputJson" JSONB,
    "errorJson" JSONB,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowStepInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowExecutionLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "stepInstanceId" TEXT,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT,
    "clientId" TEXT,
    "workflowInstanceId" TEXT,
    "workflowStepInstanceId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "taskType" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assignedUserId" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subjectTemplate" TEXT,
    "bodyTemplate" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "clientId" TEXT,
    "projectId" TEXT,
    "taskId" TEXT,
    "workflowInstanceId" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerResponseJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payloadJson" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 10,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectType_tenantId_isActive_idx" ON "ProjectType"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectType_tenantId_code_key" ON "ProjectType"("tenantId", "code");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_idx" ON "WorkflowDefinition"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_code_idx" ON "WorkflowDefinition"("tenantId", "code");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_status_idx" ON "WorkflowDefinition"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_projectTypeId_idx" ON "WorkflowDefinition"("tenantId", "projectTypeId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_isActive_idx" ON "WorkflowDefinition"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_baseDefinitionId_idx" ON "WorkflowDefinition"("baseDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_tenantId_code_version_key" ON "WorkflowDefinition"("tenantId", "code", "version");

-- CreateIndex
CREATE INDEX "WorkflowStep_tenantId_idx" ON "WorkflowStep"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowStep_workflowDefinitionId_idx" ON "WorkflowStep"("workflowDefinitionId");

-- CreateIndex
CREATE INDEX "WorkflowStep_workflowDefinitionId_orderIndex_idx" ON "WorkflowStep"("workflowDefinitionId", "orderIndex");

-- CreateIndex
CREATE INDEX "WorkflowStep_workflowDefinitionId_stepType_idx" ON "WorkflowStep"("workflowDefinitionId", "stepType");

-- CreateIndex
CREATE INDEX "WorkflowStep_workflowDefinitionId_isStart_idx" ON "WorkflowStep"("workflowDefinitionId", "isStart");

-- CreateIndex
CREATE INDEX "WorkflowStep_workflowDefinitionId_isTerminal_idx" ON "WorkflowStep"("workflowDefinitionId", "isTerminal");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_workflowDefinitionId_code_key" ON "WorkflowStep"("workflowDefinitionId", "code");

-- CreateIndex
CREATE INDEX "WorkflowTransition_tenantId_idx" ON "WorkflowTransition"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowTransition_workflowDefinitionId_idx" ON "WorkflowTransition"("workflowDefinitionId");

-- CreateIndex
CREATE INDEX "WorkflowTransition_workflowDefinitionId_fromStepId_idx" ON "WorkflowTransition"("workflowDefinitionId", "fromStepId");

-- CreateIndex
CREATE INDEX "WorkflowTransition_workflowDefinitionId_toStepId_idx" ON "WorkflowTransition"("workflowDefinitionId", "toStepId");

-- CreateIndex
CREATE INDEX "WorkflowTransition_workflowDefinitionId_transitionType_idx" ON "WorkflowTransition"("workflowDefinitionId", "transitionType");

-- CreateIndex
CREATE INDEX "WorkflowStepAction_tenantId_idx" ON "WorkflowStepAction"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowStepAction_stepId_idx" ON "WorkflowStepAction"("stepId");

-- CreateIndex
CREATE INDEX "WorkflowStepAction_stepId_triggerEvent_idx" ON "WorkflowStepAction"("stepId", "triggerEvent");

-- CreateIndex
CREATE INDEX "WorkflowStepAction_stepId_actionType_idx" ON "WorkflowStepAction"("stepId", "actionType");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_idx" ON "WorkflowInstance"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_workflowDefinitionId_idx" ON "WorkflowInstance"("tenantId", "workflowDefinitionId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_entityType_entityId_idx" ON "WorkflowInstance"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_status_idx" ON "WorkflowInstance"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_startedAt_idx" ON "WorkflowInstance"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_idx" ON "WorkflowStepInstance"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_workflowInstanceId_idx" ON "WorkflowStepInstance"("tenantId", "workflowInstanceId");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_stepDefinitionId_idx" ON "WorkflowStepInstance"("tenantId", "stepDefinitionId");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_status_idx" ON "WorkflowStepInstance"("tenantId", "status");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_assignedUserId_idx" ON "WorkflowStepInstance"("tenantId", "assignedUserId");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_availableAt_idx" ON "WorkflowStepInstance"("tenantId", "availableAt");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_dueAt_idx" ON "WorkflowStepInstance"("tenantId", "dueAt");

-- CreateIndex
CREATE INDEX "WorkflowExecutionLog_tenantId_idx" ON "WorkflowExecutionLog"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowExecutionLog_tenantId_workflowInstanceId_idx" ON "WorkflowExecutionLog"("tenantId", "workflowInstanceId");

-- CreateIndex
CREATE INDEX "WorkflowExecutionLog_tenantId_stepInstanceId_idx" ON "WorkflowExecutionLog"("tenantId", "stepInstanceId");

-- CreateIndex
CREATE INDEX "WorkflowExecutionLog_tenantId_eventType_idx" ON "WorkflowExecutionLog"("tenantId", "eventType");

-- CreateIndex
CREATE INDEX "WorkflowExecutionLog_createdAt_idx" ON "WorkflowExecutionLog"("createdAt");

-- CreateIndex
CREATE INDEX "Task_tenantId_idx" ON "Task"("tenantId");

-- CreateIndex
CREATE INDEX "Task_tenantId_projectId_idx" ON "Task"("tenantId", "projectId");

-- CreateIndex
CREATE INDEX "Task_tenantId_clientId_idx" ON "Task"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "Task_tenantId_workflowInstanceId_idx" ON "Task"("tenantId", "workflowInstanceId");

-- CreateIndex
CREATE INDEX "Task_tenantId_workflowStepInstanceId_idx" ON "Task"("tenantId", "workflowStepInstanceId");

-- CreateIndex
CREATE INDEX "Task_tenantId_assignedUserId_idx" ON "Task"("tenantId", "assignedUserId");

-- CreateIndex
CREATE INDEX "Task_tenantId_status_idx" ON "Task"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Task_tenantId_dueAt_idx" ON "Task"("tenantId", "dueAt");

-- CreateIndex
CREATE INDEX "Task_tenantId_deletedAt_idx" ON "Task"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "NotificationTemplate_tenantId_idx" ON "NotificationTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationTemplate_tenantId_channel_idx" ON "NotificationTemplate"("tenantId", "channel");

-- CreateIndex
CREATE INDEX "NotificationTemplate_tenantId_isActive_idx" ON "NotificationTemplate"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_tenantId_code_channel_key" ON "NotificationTemplate"("tenantId", "code", "channel");

-- CreateIndex
CREATE INDEX "Notification_tenantId_idx" ON "Notification"("tenantId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_userId_idx" ON "Notification"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_clientId_idx" ON "Notification"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_projectId_idx" ON "Notification"("tenantId", "projectId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_taskId_idx" ON "Notification"("tenantId", "taskId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_channel_idx" ON "Notification"("tenantId", "channel");

-- CreateIndex
CREATE INDEX "Notification_tenantId_status_idx" ON "Notification"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Notification_tenantId_scheduledAt_idx" ON "Notification"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledJob_tenantId_idx" ON "ScheduledJob"("tenantId");

-- CreateIndex
CREATE INDEX "ScheduledJob_tenantId_jobType_idx" ON "ScheduledJob"("tenantId", "jobType");

-- CreateIndex
CREATE INDEX "ScheduledJob_tenantId_status_idx" ON "ScheduledJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ScheduledJob_tenantId_runAt_idx" ON "ScheduledJob"("tenantId", "runAt");

-- CreateIndex
CREATE INDEX "ScheduledJob_status_runAt_idx" ON "ScheduledJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "ScheduledJob_tenantId_relatedEntityType_relatedEntityId_idx" ON "ScheduledJob"("tenantId", "relatedEntityType", "relatedEntityId");

-- CreateIndex
CREATE INDEX "OutboxEvent_tenantId_idx" ON "OutboxEvent"("tenantId");

-- CreateIndex
CREATE INDEX "OutboxEvent_tenantId_eventName_idx" ON "OutboxEvent"("tenantId", "eventName");

-- CreateIndex
CREATE INDEX "OutboxEvent_tenantId_aggregateType_aggregateId_idx" ON "OutboxEvent"("tenantId", "aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_idx" ON "OutboxEvent"("publishedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_failedAt_idx" ON "OutboxEvent"("failedAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_idx" ON "AuditLog"("tenantId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_actorUserId_idx" ON "AuditLog"("tenantId", "actorUserId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_entityType_entityId_idx" ON "AuditLog"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_action_idx" ON "AuditLog"("tenantId", "action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Project_tenantId_status_idx" ON "Project"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Project_tenantId_projectTypeId_idx" ON "Project"("tenantId", "projectTypeId");

-- CreateIndex
CREATE INDEX "Project_tenantId_assignedEmployeeId_idx" ON "Project"("tenantId", "assignedEmployeeId");

-- AddForeignKey
ALTER TABLE "ProjectType" ADD CONSTRAINT "ProjectType_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_projectTypeId_fkey" FOREIGN KEY ("projectTypeId") REFERENCES "ProjectType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_baseDefinitionId_fkey" FOREIGN KEY ("baseDefinitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_projectTypeId_fkey" FOREIGN KEY ("projectTypeId") REFERENCES "ProjectType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_fromStepId_fkey" FOREIGN KEY ("fromStepId") REFERENCES "WorkflowStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTransition" ADD CONSTRAINT "WorkflowTransition_toStepId_fkey" FOREIGN KEY ("toStepId") REFERENCES "WorkflowStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepAction" ADD CONSTRAINT "WorkflowStepAction_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_stepDefinitionId_fkey" FOREIGN KEY ("stepDefinitionId") REFERENCES "WorkflowStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowExecutionLog" ADD CONSTRAINT "WorkflowExecutionLog_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowExecutionLog" ADD CONSTRAINT "WorkflowExecutionLog_stepInstanceId_fkey" FOREIGN KEY ("stepInstanceId") REFERENCES "WorkflowStepInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workflowStepInstanceId_fkey" FOREIGN KEY ("workflowStepInstanceId") REFERENCES "WorkflowStepInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledJob" ADD CONSTRAINT "ScheduledJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
