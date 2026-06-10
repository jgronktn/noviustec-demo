# Customer invoicing — design

Updates the v1 "out of scope: AR invoicing" rule. We're adding it for
real, but constrained: no sales tax, simple multi-line items, single-
currency, Postmark for outbound email.

Status: **planned, not yet implemented.** Slice 1 is the next code
change.

## Scope (locked, 2026-06-09)

| Slice | What ships | Status |
|---|---|---|
| 1 — Track | New Customers, CustomerInvoices, CustomerInvoiceLines sheets. Create / edit / list / mark-sent / mark-paid / void. Multi-line items with a single-line default + "Add line" button. Outstanding invoices show on the left side of the global timeline, paired with deposits when the deposit gets linked. Agent can `propose_customer_invoice` (draft panel + Approve flow). | planned |
| 2 — PDF | Server generates a clean invoice PDF via `pdfkit` (no chromium dependency). "Download PDF" button. PDF lives in `Documents` sheet linked to the invoice. | planned |
| 3 — Email | "Send invoice" button emails customer via Postmark (outbound — same account already used for inbound). PDF attached. Tracks `sent_at` + Postmark message id. Reply-to defaults to founder's email; user-configurable. | planned |

Out of scope for this expansion (clearly noted, easy to add later):

- Sales tax of any kind.
- Recurring invoice schedules.
- Online payment (Stripe / Paypal hosted checkout).
- Partial-payment apportionment (one deposit splitting across multiple invoices).
- Multi-currency.
- Per-line discounts (whole-invoice discount lives in line items as a negative line).
- Reminders / dunning emails for overdue invoices (manual for now).

## Data model

Three new sheets, append-only as always:

**Customers**

| Column | Notes |
|---|---|
| ID | `cust_xxxxxxxx` |
| Name | display name, required |
| Email | required (no email = can't send via Postmark) |
| Billing_Address | free-text; rendered on PDF |
| Payment_Terms | "net_15" / "net_30" / "net_45" / "net_60" / "due_on_receipt" |
| Notes | internal |
| Created_At | timestamp |
| Active | bool |

**CustomerInvoices**

| Column | Notes |
|---|---|
| ID | `cinv_xxxxxxxx` |
| Customer_ID | FK to Customers |
| Customer_Name | denormalized snapshot (preserves history if customer renamed) |
| Invoice_Number | `INV-2026-001` (year + sequence, restarts on new fiscal year) |
| Issue_Date | when we created/sent it |
| Due_Date | issue_date + payment_terms_days, editable |
| Status | draft \| sent \| paid \| partially_paid \| overdue \| void |
| Subtotal | sum of line item amounts |
| Total | = subtotal (no tax) |
| Currency | "USD" default |
| Document_Path | path to the generated PDF in Documents/ |
| Sent_At | timestamp when emailed |
| Sent_Postmark_ID | Postmark message id for trace |
| Paid_At | timestamp when last linked deposit landed |
| Paid_Deposit_IDs | comma-separated GL ids of deposits that settle it (multi-link, mirrors awaiting paid_txn_id) |
| Description | short description (renders on PDF + dashboard) |
| Notes | internal |
| Source_File | for parser-imported invoices (Phase 2+) |
| Created_At | timestamp |
| Created_By | "user" \| "agent" |

**CustomerInvoiceLines**

| Column | Notes |
|---|---|
| ID | `cinvl_xxxxxxxx` |
| Invoice_ID | FK to CustomerInvoices |
| Description | required |
| Quantity | default 1 |
| Rate | unit price |
| Amount | quantity × rate, denormalized for sheet readability |
| Position | sort order on the PDF |

Invoice numbering: `INV-{YYYY}-{NNN}` where NNN is zero-padded
sequence per calendar year, computed by counting current-year
invoices + 1 at issue time. Editable in the dialog for historical
imports / corrections.

## Timeline integration

Outstanding customer invoices appear as **left-side cards** alongside
vendor invoices and card balances, paired with their settling deposit
on the right when one is linked. Different visual treatment so the
two kinds of invoices don't mix:

| Card | Color treatment |
|---|---|
| Vendor invoice (we owe) | yellow Awaiting status pill (existing) |
| Customer invoice (owed to us) | gray Awaiting status pill, "Customer" kicker, vendor field shows the customer name |
| Card balance | purple (existing) |

The reframing for the left/right semantics:
- **LEFT** = obligations and their artifacts (invoices we received, invoices we sent, card balances we owe)
- **RIGHT** = settlements (cash movements — payments out, deposits in, transfers, statements)

Income totals stripe stays unchanged. New visible count: "outstanding
customer invoices" alongside "outstanding vendor invoices" in any
KPI summary panels.

## Deposit ↔ invoice linking

Mirror of the vendor-side `Link existing payment` we shipped recently:

- AddDepositDialog gets a tab toggle: **New deposit** (current) vs
  **Link to outstanding invoice**.
- Picker shows outstanding CustomerInvoices ranked by amount-match
  and date proximity.
- Link writes the deposit's id into the invoice's `paid_deposit_ids`
  and updates invoice status (`paid` if fully covered,
  `partially_paid` otherwise).

Bank statement reconciliation (Slice 4 — deferred): credit lines on
bank statements can be booked as a new deposit against an outstanding
customer invoice in one click. Not building this in the initial
expansion; the manual link flow above covers it.

## PDF rendering

`pdfkit` (pure JS, no Chromium binary). Single template, hardcoded
layout. Sections:

1. Header — company name, address (from env), invoice number, issue
   + due dates
2. Bill-to — customer name + billing address from the Customer row
3. Description — invoice's `description` field, italic
4. Line items table — description / qty / rate / amount columns
5. Totals — right-aligned, subtotal = total (no tax row)
6. Payment instructions — bank ACH details + a note about payment
   methods accepted (from env)
7. Footer — terms note (from env)

PDF saved to `companies/<id>/documents/invoices/cinv_xxxx.pdf` and
indexed in the Documents sheet with `reference_kind="customer_invoice"`.

## Email delivery (Postmark)

Outbound emails go through the same Postmark account already wired
for inbound. Need to confirm with user:
- A verified sender signature for the From address
- The `POSTMARK_TOKEN` env var is the server token (works for both
  in + out) — verify first run

Email template, plain-text + HTML, attached PDF:

```
Subject: Invoice {invoice_number} from {company_name}

Hi {customer_name},

Attached is invoice {invoice_number} for {total} {currency}, due
{due_date}.

Payment instructions are in the PDF. Please let me know if you have
any questions.

Thanks,
{founder_name}
{founder_email}
```

Tracks `sent_at`, `sent_postmark_id`, and any bounce/spam-complaint
webhooks (later — Phase 2 if delivery issues come up).

## API endpoints

```
GET  /api/customers                  list
POST /api/customers                  create
PATCH /api/customers/:id              edit
DELETE /api/customers/:id             remove (refuses if invoices exist)

GET  /api/customer-invoices           list (filter by customer, status)
GET  /api/customer-invoices/:id       single (incl. line items)
POST /api/customer-invoices           create (with line items)
PATCH /api/customer-invoices/:id      edit metadata
PUT  /api/customer-invoices/:id/lines replace line items
POST /api/customer-invoices/:id/mark-sent
POST /api/customer-invoices/:id/mark-paid     body: { deposit_id }
POST /api/customer-invoices/:id/void
POST /api/customer-invoices/:id/generate-pdf  returns Document row
POST /api/customer-invoices/:id/email         sends via Postmark
DELETE /api/customer-invoices/:id              refuses if status != draft
```

Plus mirror on the link side:

```
POST /api/deposits/:id/link-customer-invoice  body: { invoice_id }
```

(where `:id` here is a GL transaction id for an income row.)

## Agent tools

```
list_customers
list_customer_invoices               (filter by customer, status, date range)
get_customer_invoice                 single, with line items
propose_customer_invoice             render draft panel (same pattern as propose_transaction)
mark_customer_invoice_sent           (rare — usually use the UI button)
```

The `propose_customer_invoice` is the key one — agent can hear *"draft an
invoice to Acme Corp for $5,000 of consulting work"* and produce the
draft panel for one-click approval.

## Frontend changes

Net-new components:

| Component | Purpose |
|---|---|
| `CustomersListPanel.vue` | Table of customers, edit/delete row actions |
| `CustomerInvoicesListPanel.vue` | Table of invoices with status filter, links to the canvas |
| `CreateCustomerInvoiceDialog.vue` | Multi-line item form, customer picker, payment-terms picker, generate PDF button, send button |
| `CustomerInvoicePanel.vue` | Canvas panel for a single invoice — shows status, line items, PDF preview, action buttons |
| `LinkOutstandingInvoice.vue` | Mirror of LinkExistingPayment, for the deposit-link tab |

Existing component changes:

- `VendorTimelinePanel.vue`: handles new left-side card kind for
  customer invoices. New "outstanding customer invoices" tally if
  useful.
- `AddDepositDialog.vue`: tab toggle for new-deposit vs link-to-invoice.

## Config additions

New env vars:

```
COMPANY_NAME=                 # printed on PDF header
COMPANY_ADDRESS=              # newline-separated, printed on PDF
COMPANY_PAYMENT_INSTRUCTIONS= # printed on PDF footer
COMPANY_FOOTER_NOTE=          # printed on PDF footer

INVOICE_FROM_EMAIL=           # verified Postmark sender signature
INVOICE_REPLY_TO=             # founder's email
INVOICE_BCC=                  # optional, BCC self on outgoing
```

## Build order

Strict, with check-ins between each step:

1. **Schema + storage + agent visibility** — Customers, CustomerInvoices,
   CustomerInvoiceLines sheets; CRUD storage functions; list_customers /
   list_customer_invoices agent tools. Verify against an empty ledger.
2. **Create invoice UI** — CreateCustomerInvoiceDialog with line items,
   customer creation modal, POST /api/customer-invoices. Save as draft.
3. **Timeline integration** — left-side card rendering for outstanding
   customer invoices.
4. **Mark sent / paid / void** + deposit linking flow.
5. **PDF generation** — pdfkit template, Document row, Download button.
6. **Postmark email delivery** — Send button, env var configuration,
   sent_at tracking.
7. **Agent propose_customer_invoice** — render draft panel + Approve.

Pause after each step, demo, adjust.

## Open questions to resolve before Step 6

- Postmark from-email — what verified sender signature do you have set up?
- Founder name + signature line for the email body — what should it say?
- Bank routing/account info for payment instructions on the PDF — do
  you want this printed directly, or a generic "see attached payment
  instructions" with details in a separate PDF you maintain?
- Default payment terms (Net 30 most common — confirm)
- Should the agent be able to propose an invoice for ALL drafted line
  items, or default to one line with a description and have the user
  add more?
