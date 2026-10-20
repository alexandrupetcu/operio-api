-- Ștampila devine o entitate a angajatului (EmployeeStamp) care include 1..n
-- certificări; certificarea o referă prin `stampId`. Ordinea contează: datele din
-- `stampS3Key` se mută ÎNAINTE de ștergerea coloanei.

-- CreateTable
CREATE TABLE "EmployeeStamp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "s3Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeStamp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeStamp_employeeId_idx" ON "EmployeeStamp"("employeeId");

-- AddForeignKey
ALTER TABLE "EmployeeStamp" ADD CONSTRAINT "EmployeeStamp_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeStamp" ADD CONSTRAINT "EmployeeStamp_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "EmployeeCertification" ADD COLUMN "stampId" TEXT;
ALTER TABLE "EmployeeCertification" ADD CONSTRAINT "EmployeeCertification_stampId_fkey" FOREIGN KEY ("stampId") REFERENCES "EmployeeStamp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill, identic cu regula de până acum (`stampFor`):
-- 1. fiecare certificare cu imagine de ștampilă → o ștampilă nouă, legată de ea;
CREATE TEMP TABLE _cert_authority AS
SELECT
  c."id" AS cert_id,
  c."tenantId" AS tenant_id,
  c."employeeId" AS employee_id,
  c."stampS3Key" AS s3_key,
  c."createdAt" AS created_at,
  CASE
    WHEN c."type" LIKE 'anre\_%' THEN 'ANRE'
    WHEN c."type" LIKE 'iscir\_%' THEN 'ISCIR'
    WHEN c."type" IN ('rte', 'diriginte', 'verificator', 'cq') THEN 'Construcții'
    ELSE 'Altele'
  END AS authority
FROM "EmployeeCertification" c;

INSERT INTO "EmployeeStamp" ("id", "tenantId", "employeeId", "name", "authority", "s3Key", "createdAt", "updatedAt")
SELECT 'stamp_' || cert_id, tenant_id, employee_id, 'Ștampilă ' || authority, authority, s3_key, created_at, CURRENT_TIMESTAMP
FROM _cert_authority
WHERE s3_key IS NOT NULL;

UPDATE "EmployeeCertification" c
SET "stampId" = 'stamp_' || c."id"
WHERE c."stampS3Key" IS NOT NULL;

-- 2. certificările fără imagine → prima ștampilă (cea mai veche) a aceleiași persoane
--    și autorități, cum o împrumutau până acum. „Altele” nu împrumută.
UPDATE "EmployeeCertification" c
SET "stampId" = (
  SELECT s."id"
  FROM "EmployeeStamp" s
  WHERE s."employeeId" = a.employee_id AND s."authority" = a.authority
  ORDER BY s."createdAt" ASC, s."id" ASC
  LIMIT 1
)
FROM _cert_authority a
WHERE a.cert_id = c."id"
  AND c."stampS3Key" IS NULL
  AND a.authority <> 'Altele';

DROP TABLE _cert_authority;

-- 3. imaginea stă acum pe ștampilă.
ALTER TABLE "EmployeeCertification" DROP COLUMN "stampS3Key";
