-- Performance: composite index for getByProject with parentWorkflowInstanceId filter
CREATE INDEX "WorkflowInstance_tenantId_entityType_entityId_parentWorkflow_idx" ON "WorkflowInstance"("tenantId", "entityType", "entityId", "parentWorkflowInstanceId");

-- Performance: composite index for checkJoinMode (spawnGroupId + stepDefinitionId)
CREATE INDEX "WorkflowStepInstance_spawnGroupId_stepDefinitionId_idx" ON "WorkflowStepInstance"("spawnGroupId", "stepDefinitionId");
