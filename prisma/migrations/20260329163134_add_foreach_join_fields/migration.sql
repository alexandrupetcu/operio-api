-- AlterTable
ALTER TABLE "WorkflowStep" ADD COLUMN     "joinMode" TEXT;

-- AlterTable
ALTER TABLE "WorkflowStepInstance" ADD COLUMN     "itemContextJson" JSONB,
ADD COLUMN     "spawnGroupId" TEXT;

-- AlterTable
ALTER TABLE "WorkflowTransition" ADD COLUMN     "foreachPath" TEXT,
ADD COLUMN     "itemContextKey" TEXT,
ADD COLUMN     "spawnMode" TEXT NOT NULL DEFAULT 'single';

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_spawnGroupId_idx" ON "WorkflowStepInstance"("spawnGroupId");
