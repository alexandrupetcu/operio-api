-- Distribuitorii cu seturi de dosare pentru firmele care nu îi au (create înainte ca
-- înregistrarea să îi adauge). Aceeași listă ca src/lib/default-distributors.ts.
-- Cei existenți (eventual redenumiți, cu date de contact) rămân neatinși.
INSERT INTO "Distributor" ("id", "tenantId", "code", "name", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", d.code, d.name, true, now(), now()
FROM "Tenant" t
CROSS JOIN (VALUES
  ('DISTRIGAZ', 'Distrigaz Sud Rețele S.R.L.'),
  ('NEOGAS_GRID', 'Neogas Grid S.A.'),
  ('MEGACONSTRUCT', 'Megaconstruct S.A.')
) AS d(code, name)
ON CONFLICT ("tenantId", "code") DO NOTHING;
