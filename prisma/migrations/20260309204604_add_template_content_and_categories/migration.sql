-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentCategory" ADD VALUE 'GDPR';
ALTER TYPE "DocumentCategory" ADD VALUE 'SERVICE_AGREEMENT';

-- AlterTable
ALTER TABLE "DocumentTemplate" ADD COLUMN     "content" TEXT,
ADD COLUMN     "description" TEXT,
ALTER COLUMN "s3Key" DROP NOT NULL;
