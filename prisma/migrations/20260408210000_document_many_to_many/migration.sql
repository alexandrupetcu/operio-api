-- CreateTable: ProjectDocument (junction)
CREATE TABLE "ProjectDocument" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ClientDocument (junction)
CREATE TABLE "ClientDocument" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDocument_pkey" PRIMARY KEY ("id")
);

-- Migrate existing data: move projectId links to ProjectDocument
INSERT INTO "ProjectDocument" ("id", "projectId", "documentId")
SELECT gen_random_uuid(), "projectId", "id"
FROM "Document"
WHERE "projectId" IS NOT NULL;

-- Drop old foreign key and index
ALTER TABLE "Document" DROP CONSTRAINT IF EXISTS "Document_projectId_fkey";
DROP INDEX IF EXISTS "Document_projectId_idx";

-- Drop projectId column from Document
ALTER TABLE "Document" DROP COLUMN "projectId";

-- CreateIndexes
CREATE UNIQUE INDEX "ProjectDocument_projectId_documentId_key" ON "ProjectDocument"("projectId", "documentId");
CREATE INDEX "ProjectDocument_projectId_idx" ON "ProjectDocument"("projectId");
CREATE INDEX "ProjectDocument_documentId_idx" ON "ProjectDocument"("documentId");
CREATE UNIQUE INDEX "ClientDocument_clientId_documentId_key" ON "ClientDocument"("clientId", "documentId");
CREATE INDEX "ClientDocument_clientId_idx" ON "ClientDocument"("clientId");
CREATE INDEX "ClientDocument_documentId_idx" ON "ClientDocument"("documentId");

-- AddForeignKeys
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
