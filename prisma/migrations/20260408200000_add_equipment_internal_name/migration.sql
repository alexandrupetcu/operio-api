-- Add internalName and copy existing name values
ALTER TABLE "Equipment" ADD COLUMN "internalName" TEXT;
UPDATE "Equipment" SET "internalName" = "name";

-- Make name nullable (for PDF-extracted name)
ALTER TABLE "Equipment" ALTER COLUMN "name" DROP NOT NULL;
