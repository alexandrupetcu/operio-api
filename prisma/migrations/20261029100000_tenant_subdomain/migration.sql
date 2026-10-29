-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "subdomain" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_subdomain_key" ON "Tenant"("subdomain");

