# onrmc

SaaS for ready-mix concrete plants: billing with GST, accounts, plant operations
(aggregates, batching, dispatch), live truck GPS, an owner app and a super-admin console
for subscriptions. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
apps/api      Fastify + Prisma + PostgreSQL (TypeScript)
apps/web      React + Vite + Tailwind web app (staff, owner, super admin)
apps/android  Native Android apps (Kotlin + Jetpack Compose): onrmc Driver (trips + background GPS)
              and onrmc Owner (today's numbers, private margin, trucks on a map). See apps/android/README.md
packages/shared  GST math, roles, trip states
```

## Run locally

Needs Node 22, pnpm 10 and PostgreSQL 16 (or `docker compose up -d db`).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL, JWT_SECRET
pnpm db:migrate                              # creates tables
pnpm db:seed                                 # demo company + plans
pnpm dev:api                                 # http://localhost:4000
pnpm dev:web                                 # http://localhost:5173
```

Android apps: download the APKs from the *Android apps* GitHub Actions run, or open `apps/android` in
Android Studio. On a phone, enter your computer's Wi-Fi IP on the sign-in screen. Details in
[apps/android/README.md](apps/android/README.md).

API tests: `pnpm --filter @onrmc/api test`.

### Demo logins (password `demo@123` unless noted)

| Role | Mobile |
|---|---|
| Super admin | 9000000000 / `admin@123` |
| Owner | 9111111111 |
| Manager | 9222222222 |
| Accountant | 9333333333 |
| Store (aggregates) | 9444444444 |
| Batching | 9555555555 |
| Dispatch | 9666666666 |
| Driver | 9777777777 |

## Daily flow

1. **Sales** books an order (customer, site, grade, m³; rate defaults to customer rate).
2. **Batching** records each batch with actual weights from the plant; stock is deducted.
3. **Dispatch** assigns a truck and driver → delivery challan. Driver app moves the trip
   through loaded → in transit → at site → delivered, sending GPS all the way.
4. **Accounts** bills delivered challans as a tax invoice or bill of supply; ledgers post
   automatically. Payments settle oldest invoices first.
5. **Owner** sees real margin per customer, grade and m³, and material wastage.

## Billing guarantees

- Concrete quantity on an invoice always equals the delivered challan quantity.
- Extra lines are for services only (pumping, waiting, transport) and can't use the concrete HSN.
- Totals are computed on the server; issued invoices can only be cancelled with a reason, which reverses the ledger.
- Every create, issue and cancel is written to the audit log.
