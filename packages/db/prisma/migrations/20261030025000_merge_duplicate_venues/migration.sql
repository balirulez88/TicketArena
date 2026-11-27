-- Merge venues that share a name, so the next migration can create the unique index on
-- venues(name) (TD-028). The old check-then-create seed could insert one venue twice under
-- concurrency. On a database without duplicates (any database that already has the index) every
-- statement below touches no row. The rule is documented in docs/database/index.md.
--
-- Survivor: per name, the venue with the lowest id. Its duplicates' references move to it:
--   * a duplicate's section whose name the group already holds merges into one section (the
--     survivor venue's own, else the lowest id), whose price and currency they all share;
--   * likewise a row whose label its merged section already holds merges into one row (the
--     surviving section's own, else the lowest id), and its seats move to that row;
--   * every other section and row moves as it is; events move to the survivor venue.
-- A seat is never deleted: two seats of one event on one merged row and number would violate
-- seats_eventId_rowId_number_key and abort the migration instead. That cannot happen with seeded
-- data, because an event's seats lie only on its own venue's rows.
--
-- Same-name sections merge only when they agree on priceMinor and currency. A seat's price is its
-- section's, so merging differently priced sections would silently reprice existing seats on the
-- seat map and at checkout. On any such conflict the migration aborts before it changes a row and
-- names every conflicting section, so an operator can align the prices or rename a section first.

DO $$
DECLARE
  "conflicts" TEXT;
BEGIN
  SELECT string_agg(
           format('venue %s section %s: %s', to_jsonb("venueName"), to_jsonb("sectionName"), "prices"),
           '; ' ORDER BY "venueName", "sectionName")
  INTO "conflicts"
  FROM (
    SELECT v."name" AS "venueName", sec."name" AS "sectionName",
           string_agg(format('%s %s %s', sec."id", sec."priceMinor", sec."currency"), ', '
                      ORDER BY v."id", sec."id") AS "prices"
    FROM "sections" sec
    JOIN "venues" v ON v."id" = sec."venueId"
    WHERE v."name" IN (SELECT "name" FROM "venues" GROUP BY "name" HAVING count(*) > 1)
    GROUP BY v."name", sec."name"
    HAVING count(DISTINCT (sec."priceMinor", sec."currency")) > 1
  ) "conflicting";

  IF "conflicts" IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot merge duplicate venues: same-name sections differ in price or currency (%). Merging them would reprice existing seats. Give each listed group the same priceMinor and currency, or rename all but one section of a group, then rerun the migration. See docs/database/index.md.', "conflicts";
  END IF;
END
$$;

CREATE TEMP TABLE "_merge_venues" AS
SELECT v."id" AS "duplicateId", s."id" AS "survivorId"
FROM "venues" v
JOIN (SELECT DISTINCT ON ("name") "id", "name" FROM "venues" ORDER BY "name", "id") s
  ON s."name" = v."name" AND s."id" <> v."id";

-- Sections of every venue in a duplicate group, keyed by the venue they end up on.
CREATE TEMP TABLE "_merge_sections" AS
WITH "grouped" AS (
  SELECT sec."id", sec."name", COALESCE(m."survivorId", sec."venueId") AS "venueId",
         m."survivorId" IS NULL AS "onSurvivor"
  FROM "sections" sec
  LEFT JOIN "_merge_venues" m ON m."duplicateId" = sec."venueId"
  WHERE sec."venueId" IN (SELECT "duplicateId" FROM "_merge_venues")
     OR sec."venueId" IN (SELECT "survivorId" FROM "_merge_venues")
), "ranked" AS (
  SELECT "id", first_value("id") OVER (
    PARTITION BY "venueId", "name" ORDER BY "onSurvivor" DESC, "id"
  ) AS "survivorId"
  FROM "grouped"
)
SELECT "id" AS "duplicateId", "survivorId" FROM "ranked" WHERE "id" <> "survivorId";

-- Rows of every section in a merged group, keyed by the section they end up on.
CREATE TEMP TABLE "_merge_rows" AS
WITH "grouped" AS (
  SELECT r."id", r."label", COALESCE(m."survivorId", r."sectionId") AS "sectionId",
         m."survivorId" IS NULL AS "onSurvivor"
  FROM "rows" r
  LEFT JOIN "_merge_sections" m ON m."duplicateId" = r."sectionId"
  WHERE r."sectionId" IN (SELECT "duplicateId" FROM "_merge_sections")
     OR r."sectionId" IN (SELECT "survivorId" FROM "_merge_sections")
), "ranked" AS (
  SELECT "id", first_value("id") OVER (
    PARTITION BY "sectionId", "label" ORDER BY "onSurvivor" DESC, "id"
  ) AS "survivorId"
  FROM "grouped"
)
SELECT "id" AS "duplicateId", "survivorId" FROM "ranked" WHERE "id" <> "survivorId";

UPDATE "seats" SET "rowId" = m."survivorId"
FROM "_merge_rows" m WHERE "seats"."rowId" = m."duplicateId";

DELETE FROM "rows" WHERE "id" IN (SELECT "duplicateId" FROM "_merge_rows");

UPDATE "rows" SET "sectionId" = m."survivorId"
FROM "_merge_sections" m WHERE "rows"."sectionId" = m."duplicateId";

DELETE FROM "sections" WHERE "id" IN (SELECT "duplicateId" FROM "_merge_sections");

UPDATE "sections" SET "venueId" = m."survivorId"
FROM "_merge_venues" m WHERE "sections"."venueId" = m."duplicateId";

UPDATE "events" SET "venueId" = m."survivorId"
FROM "_merge_venues" m WHERE "events"."venueId" = m."duplicateId";

DELETE FROM "venues" WHERE "id" IN (SELECT "duplicateId" FROM "_merge_venues");

DROP TABLE "_merge_rows";
DROP TABLE "_merge_sections";
DROP TABLE "_merge_venues";
