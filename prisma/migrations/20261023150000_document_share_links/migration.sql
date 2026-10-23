-- CreateTable
CREATE TABLE "DocumentShareLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "lastOpenedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentShareLink_token_key" ON "DocumentShareLink"("token");

-- CreateIndex
CREATE INDEX "DocumentShareLink_documentId_idx" ON "DocumentShareLink"("documentId");

-- CreateIndex
CREATE INDEX "DocumentShareLink_tenantId_idx" ON "DocumentShareLink"("tenantId");

-- AddForeignKey
ALTER TABLE "DocumentShareLink" ADD CONSTRAINT "DocumentShareLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

