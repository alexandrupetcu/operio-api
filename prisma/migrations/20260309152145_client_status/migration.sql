-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE';
