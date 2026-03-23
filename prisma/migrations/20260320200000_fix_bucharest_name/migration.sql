-- Rename Bucharest to București (Romanian spelling)
UPDATE "State" SET "name" = 'București' WHERE "id" = 4730 AND "name" = 'Bucharest';
UPDATE "City" SET "name" = 'București' WHERE "id" = 90347 AND "name" = 'Bucharest';
