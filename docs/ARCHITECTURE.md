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
| Mobile apps | **Native Android: Kotlin + Jetpack Compose** (Driver app, Owner app, shared `core` module) | Real Android apps; GPS through a location foreground service with an on-phone queue |
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
  ├─ Driver app (Android)   : login, today's trips, start/arrive/deliver, background GPS, receiver name + diesel
  └─ Owner app (Android)    : today's production & sales, cash/receivables, private margin, trucks on a map, alerts
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
  - `CLEARTAX` (`adapters/cleartax.ts`): e-invoice API v2. Auth token + GSTIN (+ owner id) headers; the NIC payload
    is sent unchanged as `[{ transaction }]` and the IRP's answer read from `govt_response`.
  - `MASTERS_INDIA` (`adapters/mastersindia.ts`): token from `/api/v1/token-auth/` (cached ~20 h, refreshed once on
    401); the NIC payload is mapped field by field to Masters India's snake_case format, copying values, never
    recomputing them.
  - Both default to **production** (live). Sandbox can still be picked in Settings → E-invoicing (Environment), and
    the screen shows which mode is active. Request mapping and error handling are covered by
    `apps/api/test/gsp-adapters.test.ts` against a fake server.
  - `PORTAL` (`adapters/portal.ts`, the default for new plants): no GSP account. The invoice is downloaded as NIC
    schema JSON (one invoice, or every pending invoice and note for bulk upload), uploaded at einvoice1.gst.gov.in
    with the plant's own GST login, and the portal's result JSON is imported back (`lib/einvoice/portal-import.ts`
    finds IRN, Ack no./date, signed QR and invoice in any shape and matches them by document number). The IRN can
    also be typed in. E-way bills are made on the portal and their number recorded; cancellations, vehicle changes
    and extensions done on the portal are recorded in onrmc.
  - `NIC_DIRECT` is still a stub (needs NIC API credentials, a whitelisted IP and session-key exchange).
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
  - Portal mode: `GET /einvoice/portal-json`, `POST /einvoice/portal-import`, `POST /invoices/:id/einvoice/record`,
    `POST /invoices/:id/ewaybill/record`
  - `GET /gstin/:gstin`, `GET /gstin-portal/captcha`, `POST /gstin/:gstin/portal`: free lookup through the GST
    portal's public taxpayer search (`lib/gst-portal.ts`): the user types the portal's captcha in the form, and the
    legal name, address, PIN and status fill in. Not a published API, so a portal change fails cleanly. Also:
    check digit, state, PAN and entity type from the GSTIN itself; saved details if a customer or
    supplier already has it; legal name, address, PIN and GST status from the GST system through the connected GSP
    (Masters India `get-gstin-details`). Used by the customer, supplier, order and invoice forms to fill details.
  - `GET|PUT /einvoice/settings`
  - `POST /einvoice/test`
  - `GET|PUT /company`
- **Going live:** with no GSP, choose *GST portal* and switch e-invoicing on. For automatic IRNs, create the
  company's e-invoice API user on the IRP portal for ClearTax or Masters India, save those credentials (Environment
  defaults to production) and press *Test connection*.
- **GSTIN autofill for every plant:** the super admin saves onrmc's own Masters India account under Payment
  settings → GSTIN autofill (`GET|PUT /admin/gstin-lookup`, `POST /admin/gstin-lookup/test`). Lookups use the
  plant's own GSP first, then this account, and are cached for a day.

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

## 4e. Truck maintenance

Code: `apps/api/src/routes/fleet.ts`. Web: Truck maintenance.

- **Schedules:** per truck, a task due every N km and/or every N days, whichever comes first (e.g. engine oil every
  10,000 km or 180 days, insurance every 365 days). A standard set can be added to all transit mixers in one click.
  Status: overdue, due soon (7 days or 500 km) or OK; km-based tasks need an odometer reading.
- **Service log:** date, odometer, work done, garage, parts + labour, downtime. Marking a scheduled task done moves its
  "last done" date and km; cancelling an entry moves it back.
- **Books:** paid in cash or bank → Dr Vehicle repairs & maintenance (5310, an overhead below gross profit), Cr Cash /
  Bank. If the garage's GST bill is entered under Purchase bills, the entry is marked "already on a purchase bill" and
  posts nothing, so the cost is never counted twice. Cancelling reverses the journal.
- **Cost per truck:** repairs + trip diesel for the period, per m³ delivered.

## 4f. Quality control: cube tests

Code: `apps/api/src/routes/qc.ts`. Web: Quality (cubes).

- A cube set is cast from one batch (grade and fck copied at sampling), with slump and concrete temperature.
- Results per age (7, 28 … days): failure load in kN (strength = load × 1000 / side², 150 or 100 mm cubes) or the
  strength directly.
- Checks (IS 456:2000, Amendment 4): at 28 days each sample ≥ fck − 4 (M20+) or fck − 3 (M15); the mean of the last
  4 samples of a grade ≥ fck + 4 (M20+) or fck + 3 (M15); a cube more than ±15 % from its sample mean makes the
  sample suspect. 7-day results are indicative (≈ 65 % of fck).
- "Due for testing" lists sets that reached 7 or 28 days without results; the owner app shows the count.

## 4g. Subscriptions and payments (onrmc ← plant owners)

Code: `apps/api/src/lib/subscription.ts`, `lib/gateways.ts`, `routes/subscription.ts`, admin routes in `routes/admin.ts`.
Web: owner → Subscription; super admin → Payments, Payment settings.

- **Methods**, each switched on or off by the super admin:
  - *Manual:* the owner sees a UPI QR made from the super admin's UPI ID with the exact amount filled in (or an
    uploaded QR image when there is no UPI ID), an "Open UPI app" button on phones, and the bank details; pays, and submits the UTR (and an
    optional screenshot). The super admin checks the bank statement and approves or rejects. A UTR can't be
    submitted twice.
  - *Razorpay:* Orders API + Checkout; the signature is verified on the server; `payment.captured` /
    `order.paid` webhooks (signature-checked, deduplicated) activate it too, so a closed browser doesn't lose a payment.
  - *Cashfree:* PG API 2023-08-01 + JS SDK; after checkout the server asks Cashfree for the order status (never trusts
    the browser); `PAYMENT_SUCCESS_WEBHOOK` triggers the same check.
  - Test mode: Razorpay `rzp_test_` keys and Cashfree *sandbox* are labelled "test mode" in both screens. A gateway can
    only be switched on once its keys are saved; secrets are encrypted (AES-256-GCM) and never shown again.
- **Price** is always computed on the server from the plan, with GST by place of supply (CGST+SGST in the seller's
  state, otherwise IGST). Each paid subscription gets onrmc's own GST tax invoice (`SUB/26-27/0001`, SAC 998314).
- **Activation** happens exactly once per payment (callback, webhook and approval can all race safely). A renewal
  starts from the current expiry; a lapsed account starts today.
- **Lapse:** after expiry the account has a grace period (default 7 days, banner shown), then it is **paused**: every
  write by the tenant's users is refused with 402, reads keep working, and the owner can still sign in and pay.
  An hourly sweep records the status; paying reactivates at once. A super-admin suspension blocks sign-in entirely.

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
3. **Plant depth:** batching-plant controller import (CSV / PLC integration) and pump scheduling remain.
   QC cube tests and vehicle maintenance are done.
4. **SaaS ops:** onboarding wizard, usage metering and WhatsApp/SMS invoice sharing remain. Subscription payments
   (manual, Razorpay, Cashfree) and e-invoice IRN & e-way bill (ClearTax, Masters India) are done.
