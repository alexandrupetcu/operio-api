-- CreateEnum
CREATE TYPE "EquipmentType" AS ENUM ('CENTRALA');

-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "type" "EquipmentType" NOT NULL DEFAULT 'CENTRALA';
