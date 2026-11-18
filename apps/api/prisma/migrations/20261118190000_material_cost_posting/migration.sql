-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3);


-- ───────── Data: post material consumption to the books ─────────

-- 5000 is the cost-of-materials account (rename the old "Material Consumed"; add it where missing).
UPDATE "Account" SET "name" = 'Cost of materials consumed' WHERE "code" = '5000' AND "system" = true;
INSERT INTO "Account" ("id", "tenantId", "code", "name", "type", "group", "system")
SELECT 'acc5000_' || t."id", t."id", '5000', 'Cost of materials consumed', 'EXPENSE', 'Direct Expenses', true
FROM "Tenant" t
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '1400')
  AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '5000');

-- Backfill: Dr Cost of materials consumed / Cr Inventory for every existing batch, at the cost snapshot taken when it was batched.
CREATE TEMP TABLE _batch_cost AS
SELECT b."id", b."tenantId", b."number", b."batchedAt", SUM(c."cost") AS cost
FROM "Batch" b JOIN "BatchConsumption" c ON c."batchId" = b."id"
WHERE NOT EXISTS (SELECT 1 FROM "Journal" j WHERE j."sourceType" = 'BATCH' AND j."sourceId" = b."id")
GROUP BY b."id", b."tenantId", b."number", b."batchedAt"
HAVING SUM(c."cost") <> 0;

INSERT INTO "Journal" ("id", "tenantId", "date", "narration", "sourceType", "sourceId")
SELECT 'jbatch_' || bc."id", bc."tenantId", bc."batchedAt", 'Materials consumed ' || bc."number", 'BATCH', bc."id" FROM _batch_cost bc;

INSERT INTO "JournalEntry" ("id", "journalId", "accountId", "debit", "credit")
SELECT 'jebd_' || bc."id", 'jbatch_' || bc."id", a."id", bc.cost, 0
FROM _batch_cost bc JOIN "Account" a ON a."tenantId" = bc."tenantId" AND a."code" = '5000'
UNION ALL
SELECT 'jebc_' || bc."id", 'jbatch_' || bc."id", a."id", 0, bc.cost
FROM _batch_cost bc JOIN "Account" a ON a."tenantId" = bc."tenantId" AND a."code" = '1400';

-- Opening stock: bring the Inventory ledger in line with the stock valuation (qty × weighted average cost),
-- against Capital, dated when the tenant was created. Covers stock that was loaded without a journal.
CREATE TEMP TABLE _opening AS
SELECT t."id" AS tid, t."createdAt",
  ROUND(
    COALESCE((SELECT SUM(s."quantity" * m."avgCost") FROM "Stock" s JOIN "Material" m ON m."id" = s."materialId" WHERE s."tenantId" = t."id"), 0)
    - COALESCE((SELECT SUM(e."debit" - e."credit") FROM "JournalEntry" e JOIN "Account" a ON a."id" = e."accountId" WHERE a."tenantId" = t."id" AND a."code" = '1400'), 0)
  , 2) AS diff
FROM "Tenant" t
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '1400')
  AND EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '3000');
DELETE FROM _opening WHERE diff = 0;

INSERT INTO "Journal" ("id", "tenantId", "date", "narration", "sourceType", "sourceId")
SELECT 'jopen_' || o.tid, o.tid, o."createdAt", 'Opening stock (matched to stock valuation)', 'OPENING_STOCK', NULL FROM _opening o;

INSERT INTO "JournalEntry" ("id", "journalId", "accountId", "debit", "credit")
SELECT 'jeoi_' || o.tid, 'jopen_' || o.tid, a."id", GREATEST(o.diff, 0), GREATEST(-o.diff, 0)
FROM _opening o JOIN "Account" a ON a."tenantId" = o.tid AND a."code" = '1400'
UNION ALL
SELECT 'jeoc_' || o.tid, 'jopen_' || o.tid, a."id", GREATEST(-o.diff, 0), GREATEST(o.diff, 0)
FROM _opening o JOIN "Account" a ON a."tenantId" = o.tid AND a."code" = '3000';

DROP TABLE _batch_cost;
DROP TABLE _opening;
