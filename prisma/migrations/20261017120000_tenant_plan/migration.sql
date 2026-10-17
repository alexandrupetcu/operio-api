-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "entitlementOverrides" JSONB,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'execution',
ADD COLUMN     "planUntil" TIMESTAMP(3);

