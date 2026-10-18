-- AlterTable
ALTER TABLE "User" ADD COLUMN     "invitePending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invitedAt" TIMESTAMP(3);

