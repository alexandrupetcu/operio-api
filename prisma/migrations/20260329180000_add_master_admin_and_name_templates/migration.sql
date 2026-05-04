-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'MASTER_ADMIN';

-- AlterTable: User.tenantId nullable for MASTER_ADMIN users
ALTER TABLE "User" ALTER COLUMN "tenantId" DROP NOT NULL;

-- AlterTable: Add unique constraint on email (for master admins who have no tenantId)
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- AlterTable: WorkflowStep — add nameTemplate
ALTER TABLE "WorkflowStep" ADD COLUMN "nameTemplate" TEXT;

-- AlterTable: WorkflowStepInstance — add displayName
ALTER TABLE "WorkflowStepInstance" ADD COLUMN "displayName" TEXT;
