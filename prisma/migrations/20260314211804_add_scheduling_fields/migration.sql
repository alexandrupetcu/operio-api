-- AlterEnum
ALTER TYPE "ProjectStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "assignedEmployeeId" TEXT,
ADD COLUMN     "scheduledDate" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
