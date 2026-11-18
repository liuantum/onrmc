# onrmc — Architecture Plan

onrmc is a multi-tenant SaaS for ready-mix concrete (RMC) plants. A super admin sells
subscriptions; each plant owner (tenant) runs billing, accounts, plant operations and a
truck fleet on it.

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 16** | ACID money math (`NUMERIC`), row-level tenant isolation, PostGIS-ready for GPS |
| ORM / migrations | **Prisma** | Typed schema, safe migrations |
| API | **Node 22 + TypeScript + Fastify** | Fastest mainstream Node framework, schema validation with **Zod** |
| Auth | JWT access tokens + refresh, bcrypt (argon2 later), role-based permissions | |
| Realtime | WebSocket (Fastify websocket) for live truck positions & dashboards | |
| Web app | **React 18 + Vite + TypeScript + Tailwind + TanStack Query + React Router** | Fast dev/build, cached data fetching, clean UI |
| Maps | Leaflet + OpenStreetMap (swap to Google Maps if preferred) | Free, no key needed |
| Mobile apps | **React Native + Expo** (Driver app, Owner app) | One codebase for Android + iOS, background GPS via `expo-location` |
| PDFs | Server-side invoice/challan PDF (browser print stylesheet first, Puppeteer later) | |
| Monorepo | pnpm workspaces; `packages/shared` holds types, GST math, enums | One source of truth for calculations |
| Deploy | Docker images; Postgres managed (RDS / Neon / Supabase); web on CDN | |

## 2. Apps & who uses them

```
                ┌────────────── Super Admin (web /admin) ──────────────┐
                │ plans, tenants, subscriptions, usage, suspend/renew  │
                └──────────────────────────────────────────────────────┘
 Tenant (one RMC company, 1..n plants)
  ├─ Web app (staff, by role)
  │    ├─ Sales & Billing   : customers, sites, quotes, orders, invoices, credit notes
  │    ├─ Accounts          : ledgers, receivables/ageing, payables, payments, expenses, GST reports
  │    ├─ Aggregates / Store: suppliers, material receipts (GRN), stock, consumption
  │    ├─ Mixing / Batching : mix designs, batch tickets, actual vs design consumption
  │    ├─ Dispatch          : delivery challans, truck assignment, live fleet map
  │    └─ Owner analytics   : owner-only margin, cost per m³, plant efficiency
  ├─ Driver app (Expo)      : login, today's trips, start/arrive/deliver, background GPS, photo/sign POD
  └─ Owner app (Expo)       : today's production & sales, cash/receivables, live trucks, alerts
```

## 3. Core flow (single source of truth)

```
Order ─▶ Batch ticket (actual m³ and materials consumed, from batching)
        ─▶ Delivery challan (truck, driver, m³ delivered, POD)
            ─▶ Invoice lines pulled from challans (qty cannot exceed delivered qty)
                ─▶ Ledger postings (customer Dr, Sales Cr, GST output Cr)
                    ─▶ Payments / receipts settle the invoice
```

- Invoice quantities come from delivery challans; the server recomputes every total.
- Issued invoices are immutable. Corrections go through credit/debit notes.
- Every create/update/cancel writes to `AuditLog`.

## 4. Invoices and GST (done properly)

- **Tax invoice** for GST-registered sales: CGST+SGST (intra-state) or IGST (inter-state),
  HSN 3824 50 10 for ready-mix concrete, place of supply derived from site state.
- **Bill of supply / non-GST** document type where GST genuinely does not apply.
- Separate number series per type and financial year (e.g. `INV/25-26/0001`).
- GSTR-1 style sales register export and e-invoice / e-way bill fields reserved for integration.

## 4a. E-invoice (IRN) and e-way bill

Code: `apps/api/src/lib/einvoice/` (payload, validation, adapters) and `apps/api/src/routes/einvoice.ts`.

- **When:** B2B tax invoices only (customer has a GSTIN) and only when the tenant turns e-invoicing on.
  These invoices are created as `PENDING`. A bill of supply or a B2C invoice is `NOT_REQUIRED`.
- **Payload:** NIC IRP schema v1.1, built from the invoice exactly as stored. It uses the same lines
  and the same server-computed taxable value, CGST/SGST/IGST, round-off and total that are in the
  ledger and the GST summary. Nothing is recalculated for the portal.
  - Before anything is sent, the payload must reconcile to the paise: lines add up to the header, and
    taxable + tax + round-off equals the total. Otherwise it is refused with a list of problems.
  - GSTINs are checked for format, state prefix and check digit. PIN codes and state codes are checked too.
  - Concrete lines must use HSN 3824…; charge lines must use a SAC code (99…).
  - `GET /invoices/:id/einvoice/preview` shows the exact JSON, or the problems to fix first.
- **Providers:** the `GspAdapter` interface covers generateIrn, cancelIrn, getIrnByDocNo,
  generateEwbByIrn, updatePartB, cancelEwb and extendValidity.
  - `MOCK` works offline. Its IRN = SHA-256(GSTIN + FY + doc type + doc no), like NIC's. Its QR and
    signed invoice are JWT-shaped but not signed by NIC. It applies the 24 h cancel windows and the
    e-way bill validity rule (1 day per 200 km).
  - `CLEARTAX`, `MASTERS_INDIA` and `NIC_DIRECT` are stubs. They fail with a clear message until
    they are implemented and given credentials.
- **Credentials:** encrypted with AES-256-GCM using `EINVOICE_ENC_KEY` from the API environment.
  They are write-only from the UI and never returned or logged.
- **Rules enforced:**
  - An invoice with an active IRN cannot be cancelled; cancel the IRN first.
  - An IRN can be cancelled only within 24 h. After that the answer is a credit note.
  - An IRN cannot be cancelled while an e-way bill is active.
  - A cancelled IRN's document number cannot be registered again.
  - One active e-way bill per invoice. It is generated from the IRN, with the truck and distance
    defaulting from the challan and the plant → site locations.
  - Every action (generate, cancel, vehicle update, extend, failures, settings changes) is written to the audit log.
- **Endpoints:**
  - `POST /invoices/:id/einvoice`
  - `POST /invoices/:id/einvoice/cancel`
  - `GET /invoices/:id/ewaybill/defaults`
  - `POST /invoices/:id/ewaybill`
  - `PATCH /ewaybill/:id/vehicle`
  - `POST /ewaybill/:id/cancel`
  - `POST /ewaybill/:id/extend`
  - `GET|PUT /einvoice/settings`
  - `POST /einvoice/test`
  - `GET|PUT /company`
- **Going live:** needs a GSP account (sandbox, then production), the company's e-invoice API user
  created on the IRP/EWB portal for that GSP, and the adapter for that GSP filled in (see the TODOs in
  `adapters/stubs.ts`).

## 4b. Inventory and cost of materials in the books

- **Goods receipt:** Dr Inventory (1400) + GST input credit, Cr supplier. It never posts to an expense,
  so nothing is counted twice. The material's weighted average cost is updated at that point.
- **Batch:** Dr Cost of materials consumed (5000), Cr Inventory (1400) for the actual quantities, at
  the weighted average cost at that moment. The amount equals the batch's stored consumption snapshot.
- **Batch cancel** (a batch entered by mistake, with no challan yet) restores the stock and reverses the journal.
- **Opening stock** is posted Dr Inventory / Cr Capital (in the seed; for existing tenants the
  `material_cost_posting` migration back-posts old batches and adds the opening entry).
- **P&L:** sales − cost of materials consumed = gross profit, then expenses = net profit.
- **Balance sheet:** shows the Inventory ledger next to the stock valuation (qty × average cost).
  Only rounding differences remain.
- **Owner margin view:** its totals come from the same P&L function, so for the same dates revenue,
  material cost, gross and net profit are identical. The customer/grade split attributes those same
  invoice and batch journals. Trip diesel recorded on challans is shown for information only; it
  reaches the books when it is booked as an expense voucher.

- **Challan diesel** is posted when it is entered or changed on a challan: Dr Diesel / Fuel expense (5100), Cr Cash.
  A change reverses the earlier entry and posts the new amount; a cancelled challan ends at zero (`lib/diesel.ts`).
  Diesel is a direct expense, so it sits above gross profit in the P&L. In the owner margin view it is split
  per customer and grade by challan, so the two still agree exactly.

## 4c. Credit and debit notes

Code: `apps/api/src/routes/notes.ts`. Web: Invoice page → Credit note / Debit note; `/notes` list; `/notes/:id` print view.

- **What a note copies from its invoice:** a note is issued against one issued invoice. It has its own
  number series per FY (`CN/26-27/0001`, `DN/26-27/0001`). It takes the invoice's place of supply, tax
  type (CGST+SGST or IGST, or none for a bill of supply) and each line's GST rate.
- **Credit note reasons:**
  - Rate difference.
  - Quantity returned or short supply. Quantity is capped at the billed challan quantity not yet returned.
  - Post-supply discount (value only, no quantity).
  - Full reversal when the invoice's IRN is older than 24 h and can no longer be cancelled.
  - In every case a credit note cannot exceed what is left of each line or of the invoice.
- **Debit notes** are rate differences only, on at most the billed quantity not yet returned. They can
  never add concrete quantity beyond what was delivered.
- **Ledger:**
  - Credit note: Dr Sales returns & discounts (4900) + output CGST/SGST/IGST, Cr customer.
  - Debit note: Dr customer, Cr sales (4000/4100) + output GST.
  - Cancelling a note (with a reason) reverses the entry.
- **Invoice balance:**
  - Balance due is `total + noteAdj − paid`. A debit note adds to it.
  - A credit note is applied to the invoice balance first. The rest is customer credit, shown in receivables.
  - Payment allocation uses this balance.
- **Reports and e-invoice:**
  - The GST summary lists notes (credit notes negative) and nets them into the totals.
  - The owner margin view attributes notes to the customer and grade.
  - When e-invoicing is on, a B2B tax-invoice note is registered as CRN/DBN through the same adapter, with
    the original invoice in `RefDtls.PrecDocDtls`.
- **Blocking rules:**
  - An invoice with notes cannot be cancelled.
  - A note with an active IRN cannot be cancelled until the IRN is cancelled.

## 4d. Suppliers, purchase bills and payables

Code: `apps/api/src/routes/purchases.ts`. Web: Suppliers, Purchase bills, Supplier payments, and the Accounts → Payables and GST tabs.

- **Suppliers:**
  - GSTIN is validated, and the state comes from the GSTIN (or is entered for unregistered suppliers).
  - Each supplier has a PIN, payment terms, an RCM-by-default flag (unregistered / GTA) and an opening
    balance. The opening balance is posted once: Dr Capital / Cr supplier.
- **Goods receipt (GRN):** Dr Inventory at the GRN rate / Cr Goods received, not billed (2150). The
  supplier is credited only when their bill is entered. Receipts from before this change had already
  credited the supplier, so they are flagged `legacyPosted` and never billed.
- **Material bill**, against one or more unbilled GRNs of that supplier:
  - Every GRN material must be on the bill. The bill quantity and rate are compared with the GRN, and
    the variance is shown.
  - It clears the GRN value from 2150.
  - The rate difference on received quantity revalues the moving average. The share still in stock goes
    to Inventory; the share already consumed goes to Cost of materials consumed.
  - Quantity billed beyond what was received is held in Supplier claims (1530) until a short-supply
    debit note clears it.
- **Expense bill:** debits the chosen expense account.
- **Every bill:**
  - Input GST goes to 1500: CGST+SGST, or IGST when the supplier's state differs from yours.
  - Under reverse charge (RCM), the same GST is credited to 2230 and the supplier is credited without GST.
  - TDS (section and %) is credited to 2300 and reduces what the supplier is paid. TCS is debited to 1520 and increases it.
  - When the paper bill total is entered, it must agree within ₹1; the difference goes to Round off.
- **Supplier payments:** Dr supplier / Cr Cash or Bank, allocated to the oldest due bills first.
- **Debit notes to suppliers:**
  - Short supply: clears the claim.
  - Rate difference or other: reverses inventory or expense value and the average cost.
  - Each note reverses the input GST and is set off against the bill.
- **Reports:**
  - Payables ageing by bill due date, plus the ledger balance. Opening balances, legacy receipts and
    advances show as "not on bills".
  - The supplier ledger.
  - ITC in the GST summary: regular and reverse charge, net of supplier debit notes.
  - Creditors on the balance sheet.

## 5. Owner-only analytics (private, built from true data)

The owner sees what staff and customers don't: real cost per m³ (materials at purchase
price × actual batch consumption + diesel + labour), margin per invoice / customer / mix /
plant, wastage (design vs actual material used), outstanding risk per customer.
This is restricted by role (`OWNER`), not by hiding numbers — invoices, GST records and
ledgers always show the same real figures.

> **Not built:** a hidden mode that adds extra aggregate quantities to customer invoices,
> or a second concealed set of amounts kept away from GST records. That is overbilling and
> GST evasion. Margin is improved transparently via pricing: mix-wise rates, pumping/
> transport charges, minimum-load charges, waiting charges, and price revisions.

## 6. Multi-tenancy & security

- Every business table carries `tenantId`; the API injects it from the JWT on every query
  (Prisma extension). Postgres Row Level Security can be enabled as a second wall.
- Roles: `SUPER_ADMIN`, `OWNER`, `MANAGER`, `ACCOUNTANT`, `SALES`, `STORE`, `BATCHING`,
  `DISPATCH`, `DRIVER`. Permissions checked per route.
- Subscriptions gate features & limits (plants, users, trucks) via `Plan.limits`.

## 7. GPS tracking

- Driver app posts location every 15–30 s while a trip is active (background task),
  batched if offline.
- `GpsPoint` table (partition by month when large); latest position cached on `Vehicle`.
- Web fleet map and owner app receive updates over WebSocket.
- Trip states: `ASSIGNED → LOADED → IN_TRANSIT → AT_SITE → UNLOADING → DELIVERED → RETURNED`.

## 8. Build phases

1. **Foundation (this scaffold):** monorepo, schema, auth, tenants/plans, customers, orders,
   batching, challans, invoices with GST, payments, ledger, GPS ingest, owner analytics API,
   web app shell + key screens, driver & owner app shells.
2. **Accounts depth:** chart of accounts, journal vouchers, payables, expenses, bank
   reconciliation, P&L, balance sheet, GST reports.
3. **Plant depth:** batching-plant controller import (CSV / PLC integration), QC cube tests,
   pump scheduling, vehicle maintenance & diesel log.
4. **SaaS ops:** Razorpay subscription billing, onboarding wizard, usage metering,
   WhatsApp/SMS invoice sharing, e-invoice IRN & e-way bill.
