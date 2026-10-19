-- CreateTable
CREATE TABLE "EmployeeCertification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "number" TEXT,
    "domain" TEXT,
    "issuedAt" DATE,
    "expiresAt" DATE,
    "stampS3Key" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeCertification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeCertification_tenantId_expiresAt_idx" ON "EmployeeCertification"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "EmployeeCertification_employeeId_idx" ON "EmployeeCertification"("employeeId");

-- AddForeignKey
ALTER TABLE "EmployeeCertification" ADD CONSTRAINT "EmployeeCertification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeCertification" ADD CONSTRAINT "EmployeeCertification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: legitimațiile/atestatele scrise până acum în Employee.credentials (după
-- funcție) devin certificări. `credentials` rămâne neatins — dosarele de proiect îl
-- citesc în continuare ca rezervă.
WITH src AS (
  SELECT
    e."id" AS employee_id,
    e."tenantId" AS tenant_id,
    e."position" AS pos,
    NULLIF(btrim(e."credentials"->>'legitimatie'), '') AS legitimatie,
    upper(NULLIF(btrim(e."credentials"->>'tip'), '')) AS tip,
    NULLIF(btrim(e."credentials"->>'valabilitate'), '') AS valabilitate,
    NULLIF(btrim(e."credentials"->>'autorizatie'), '') AS autorizatie,
    NULLIF(btrim(e."credentials"->>'atestat'), '') AS atestat,
    NULLIF(btrim(e."credentials"->>'domeniu'), '') AS domeniu,
    NULLIF(btrim(e."credentials"->>'autorizatii'), '') AS autorizatii,
    NULLIF(btrim(e."credentials"->>'poanson'), '') AS poanson
  FROM "Employee" e
  WHERE e."credentials" IS NOT NULL AND jsonb_typeof(e."credentials"::jsonb) = 'object'
),
mapped AS (
  SELECT
    employee_id, tenant_id,
    CASE
      WHEN pos = 'instalator' AND tip IN ('EGIU','EGD','EGT','EGL') THEN 'anre_' || lower(tip)
      WHEN pos = 'proiectant' AND tip IN ('PGIU','PGD','PGT','PGL') THEN 'anre_' || lower(tip)
      WHEN pos IN ('instalator','proiectant') THEN 'other'
      WHEN pos IN ('rte','diriginte','verificator') THEN pos
      WHEN pos = 'sudor' THEN 'other'
    END AS type,
    CASE
      WHEN pos = 'instalator' AND (tip IS NULL OR tip NOT IN ('EGIU','EGD','EGT','EGL'))
        THEN 'Legitimație ANRE instalator' || COALESCE(' ' || tip, '')
      WHEN pos = 'proiectant' AND (tip IS NULL OR tip NOT IN ('PGIU','PGD','PGT','PGL'))
        THEN 'Legitimație ANRE proiectant' || COALESCE(' ' || tip, '')
      WHEN pos = 'sudor' THEN 'Autorizații sudor'
    END AS label,
    CASE
      WHEN pos IN ('instalator','proiectant','diriginte','verificator') THEN legitimatie
      WHEN pos = 'rte' THEN COALESCE(atestat, autorizatie)
      WHEN pos = 'sudor' THEN autorizatii
    END AS number,
    CASE
      WHEN pos IN ('diriginte','verificator') THEN domeniu
      WHEN pos = 'sudor' THEN poanson
    END AS domain,
    CASE WHEN valabilitate ~ '^\d{4}-\d{2}-\d{2}$' THEN valabilitate::date END AS expires_at,
    CASE
      WHEN pos = 'rte' AND atestat IS NOT NULL AND autorizatie IS NOT NULL THEN 'Autorizație: ' || autorizatie
      WHEN pos = 'diriginte' AND autorizatie IS NOT NULL THEN 'Autorizație: ' || autorizatie
    END AS notes
  FROM src
)
INSERT INTO "EmployeeCertification" ("id", "tenantId", "employeeId", "type", "label", "number", "domain", "expiresAt", "notes", "updatedAt")
SELECT gen_random_uuid()::text, tenant_id, employee_id, type, label, number, domain, expires_at, notes, CURRENT_TIMESTAMP
FROM mapped
WHERE type IS NOT NULL AND (number IS NOT NULL OR domain IS NOT NULL);
