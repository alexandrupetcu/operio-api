-- Sediul, telefonul și faxul distribuitorilor standard (site-urile lor, 28.10.2026), doar unde
-- firma n-a completat nimic. Aceeași listă ca src/lib/default-distributors.ts.
UPDATE "Distributor" d SET "contactJson" = c.contact::jsonb, "updatedAt" = now()
FROM (VALUES
  ('DISTRIGAZ', '{"address": "Bd. Mărășești nr. 4-6, Corp B", "sector": "Sector 4", "region": "București", "phone": "021 9376"}'),
  ('NEOGAS_GRID', '{"address": "Str. Grigore Alexandrescu nr. 89-97, Metropolis Building, Corp B, etaj Mezanin", "sector": "Sector 1", "region": "București", "phone": "031.690.46.85", "fax": "021.230.02.95"}'),
  ('MEGACONSTRUCT', '{"address": "Piața Unirii nr. 1, Corp Central, etaj 5, Spațiul C5.02", "sector": "Sector 3", "region": "București", "phone": "021.310.30.15", "fax": "021.313.00.33"}')
) AS c(code, contact)
WHERE d."code" = c.code AND (d."contactJson" IS NULL OR d."contactJson" = 'null'::jsonb);
