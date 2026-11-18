-- Round-off on purchase bills
INSERT INTO "Account" ("id", "tenantId", "code", "name", "type", "group", "system")
SELECT 'acc5400_' || t."id", t."id", '5400', 'Round off', 'EXPENSE', 'Indirect Expenses', true FROM "Tenant" t
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '1100')
  AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."tenantId" = t."id" AND a."code" = '5400');
