-- Tipurile de proiect de bază pentru firmele care nu le au (create înainte ca
-- înregistrarea să le adauge). Aceeași listă ca src/lib/default-project-types.ts.
-- Cele existente (eventual redenumite) rămân neatinse.
INSERT INTO "ProjectType" ("id", "tenantId", "code", "name", "description", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", d.code, d.name, d.description, true, now(), now()
FROM "Tenant" t
CROSS JOIN (VALUES
  ('bransament', 'Branșament Gaz', 'Proiecte de branșament la rețeaua de gaze naturale'),
  ('conducta', 'Extindere Conductă', 'Proiecte de extindere a conductei de gaze'),
  ('revizie_centrala', 'Revizie Centrală', 'Revizii periodice ale centralelor termice'),
  ('dosar_iscir', 'Dosar ISCIR', 'Dosare pentru inspecții ISCIR')
) AS d(code, name, description)
ON CONFLICT ("tenantId", "code") DO NOTHING;
