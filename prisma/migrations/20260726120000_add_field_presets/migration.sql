-- CreateTable
CREATE TABLE "FieldPreset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FieldPreset_tenantId_scope_idx" ON "FieldPreset"("tenantId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "FieldPreset_tenantId_scope_normalized_key" ON "FieldPreset"("tenantId", "scope", "normalized");

-- AddForeignKey
ALTER TABLE "FieldPreset" ADD CONSTRAINT "FieldPreset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
