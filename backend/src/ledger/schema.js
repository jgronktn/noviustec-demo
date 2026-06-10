// Workbook schema: sheets, columns, and default category seeds.
//
// Conventions:
// - Every sheet has a stable column order keyed by `key` (used by exceljs to
//   add/read rows by object).
// - Column types are enforced when reading back (see workbook.js / pending.js).
// - Header row gets bold + light-gray formatting (set in workbook.js).
//
// ⚠️ MIGRATIONS: new columns added to an existing sheet MUST APPEND at
// the END of the column array. NEVER insert mid-sheet. ExcelJS reassigns
// column keys when a workbook reloads but does NOT move existing cell
// data — inserting mid-sheet shifts every legacy row's values
// one column right and silently corrupts the data. We learned this the
// hard way on 2026-05-20 (see scripts/repair-schema-shift-2026-05-20.js).
// If the logical column ordering of a sheet matters to you, factor that
// in BEFORE the first import; you can't reorder later without a
// migration script.

export const SHEETS = {
  CATEGORIES: "Categories",
  SOURCES: "Sources",
  PENDING: "PendingInbox",
  GL: "GL",
  AWAITING: "AwaitingPayment",
  DOCUMENTS: "Documents",
  STATEMENTS: "Statements",
  STATEMENT_LINES: "StatementLines",
  TRANSFERS: "Transfers",
};

export const COLUMNS = {
  [SHEETS.CATEGORIES]: [
    { header: "Name", key: "name", width: 32 },
    { header: "Type", key: "type", width: 12 }, // "expense" | "revenue" | "transfer"
    { header: "Description", key: "description", width: 50 },
    { header: "Account_Code", key: "account_code", width: 14 },
    { header: "Active", key: "active", width: 8 },
  ],
  [SHEETS.SOURCES]: [
    { header: "Name", key: "name", width: 32 },
    { header: "Type", key: "type", width: 16 }, // "credit_card" | "bank_account" | "cash" | "other"
    { header: "Last4", key: "last4", width: 8 },
    { header: "Institution", key: "institution", width: 24 },
    { header: "Description", key: "description", width: 40 },
    { header: "Active", key: "active", width: 8 },
  ],
  [SHEETS.PENDING]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Status", key: "status", width: 12 }, // "pending" | "approved" | "rejected"
    { header: "Received_At", key: "received_at", width: 22 },
    { header: "Source_File", key: "source_file", width: 50 },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Total", key: "total", width: 12, style: { numFmt: '#,##0.00' } },
    { header: "Currency", key: "currency", width: 8 },
    { header: "Reference_Number", key: "reference_number", width: 22 },
    { header: "Reference_Kind", key: "reference_kind", width: 14 }, // invoice|receipt|order|transaction|confirmation|other
    { header: "Suggested_Category", key: "suggested_category", width: 28 },
    { header: "Suggested_Source", key: "suggested_source", width: 28 },
    { header: "Confidence", key: "confidence", width: 10, style: { numFmt: "0.00" } },
    { header: "Reason", key: "reason", width: 24 },
    { header: "Resolved_At", key: "resolved_at", width: 22 },
    { header: "Resolution_Notes", key: "resolution_notes", width: 40 },
  ],
  [SHEETS.GL]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Description", key: "description", width: 40 },
    { header: "Category", key: "category", width: 28 },
    { header: "Payment_Source", key: "payment_source", width: 28 },
    { header: "Amount", key: "amount", width: 12, style: { numFmt: '#,##0.00' } },
    { header: "Currency", key: "currency", width: 8 },
    { header: "Reference_Number", key: "reference_number", width: 22 },
    { header: "Reference_Kind", key: "reference_kind", width: 14 },
    { header: "Document_Path", key: "document_path", width: 60 }, // primary doc; full list in Documents sheet
    { header: "Notes", key: "notes", width: 50 },
    { header: "Source_File", key: "source_file", width: 50 },
    { header: "Pending_ID", key: "pending_id", width: 16 },
    { header: "Created_At", key: "created_at", width: 22 },
    { header: "Created_By", key: "created_by", width: 12 }, // "user" | "agent"
    // ⚠️ APPENDED 2026-06-08 — see schema migration rule at top of file.
    // "expense" (default; money going out to a vendor) or "income"
    // (deposit — money coming in: revenue, investor capital, loan
    // proceeds, refunds received, etc.). Null on legacy rows is
    // treated as "expense".
    { header: "Entry_Type", key: "entry_type", width: 10 },
  ],
  [SHEETS.AWAITING]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Status", key: "status", width: 14 }, // awaiting | paid | written_off | rejected
    // "expense" (default; pay-flow creates a GL row) or "transfer"
    // (pay-flow creates a Transfer row — used for credit-card balances
    // that get settled by moving money between your own accounts).
    // Null on legacy rows is treated as "expense".
    { header: "Payment_Kind", key: "payment_kind", width: 12 },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } }, // invoice date
    { header: "Amount", key: "amount", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Currency", key: "currency", width: 8 },
    { header: "Reference_Number", key: "reference_number", width: 22 },
    { header: "Reference_Kind", key: "reference_kind", width: 14 },
    { header: "Description", key: "description", width: 40 },
    { header: "Notes", key: "notes", width: 50 },
    { header: "Document_Path", key: "document_path", width: 60 },
    { header: "Source_File", key: "source_file", width: 50 },
    { header: "Pending_ID", key: "pending_id", width: 16 },
    { header: "Statement_ID", key: "statement_id", width: 16 }, // FK when this awaiting was auto-created from a card statement
    { header: "Created_At", key: "created_at", width: 22 },
    { header: "Paid_At", key: "paid_at", width: 22 },
    { header: "Paid_TXN_ID", key: "paid_txn_id", width: 16 },
    { header: "Paid_Transfer_ID", key: "paid_transfer_id", width: 16 },
  ],
  [SHEETS.DOCUMENTS]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Reference_Kind", key: "reference_kind", width: 14 },
    { header: "Reference_Number", key: "reference_number", width: 22 },
    { header: "Filename", key: "filename", width: 50 },
    { header: "Original_Filename", key: "original_filename", width: 50 },
    { header: "Document_Path", key: "document_path", width: 60 },
    { header: "TXN_ID", key: "txn_id", width: 16 },
    { header: "Pending_ID", key: "pending_id", width: 16 },
    { header: "Created_At", key: "created_at", width: 22 },
    { header: "Awaiting_ID", key: "awaiting_id", width: 16 },
  ],
  [SHEETS.STATEMENTS]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Status", key: "status", width: 18 }, // imported | needs_attention | reconciled | partially_reconciled
    { header: "Source", key: "source", width: 32 }, // payment source (Sources sheet name)
    // "credit_card" | "bank_account" | "cash" | "other" — captured from
    // the parser. Drives whether we auto-create an awaiting-transfer
    // for the closing balance on import (credit cards only).
    { header: "Source_Kind", key: "source_kind", width: 14 },
    { header: "Period_Start", key: "period_start", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Period_End", key: "period_end", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Statement_Date", key: "statement_date", width: 14, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Currency", key: "currency", width: 8 },
    { header: "Opening_Balance", key: "opening_balance", width: 14, style: { numFmt: "#,##0.00" } },
    { header: "Closing_Balance", key: "closing_balance", width: 14, style: { numFmt: "#,##0.00" } },
    { header: "Total_Charges", key: "total_charges", width: 14, style: { numFmt: "#,##0.00" } },
    { header: "Total_Payments", key: "total_payments", width: 14, style: { numFmt: "#,##0.00" } },
    { header: "Transaction_Count", key: "transaction_count", width: 8 },
    { header: "Document_Path", key: "document_path", width: 60 },
    { header: "Original_Filename", key: "original_filename", width: 50 },
    { header: "Source_File", key: "source_file", width: 50 },
    { header: "Pending_ID", key: "pending_id", width: 16 },
    { header: "Created_At", key: "created_at", width: 22 },
    { header: "Notes", key: "notes", width: 50 },
  ],
  [SHEETS.STATEMENT_LINES]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Statement_ID", key: "statement_id", width: 16 },
    { header: "Line_Date", key: "line_date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Description", key: "description", width: 60 },
    { header: "Amount", key: "amount", width: 12, style: { numFmt: "#,##0.00;(#,##0.00)" } }, // signed
    { header: "Balance_After", key: "balance_after", width: 14, style: { numFmt: "#,##0.00" } },
    { header: "Matched_TXN_ID", key: "matched_txn_id", width: 16 },
    { header: "Matched_Transfer_ID", key: "matched_transfer_id", width: 16 },
    { header: "Match_Method", key: "match_method", width: 12 }, // auto | manual | null
    { header: "Notes", key: "notes", width: 40 },
    { header: "Created_At", key: "created_at", width: 22 },
  ],
  // Inter-account transfers. One row per money movement between two
  // accounts you control (e.g., paying a credit card from checking).
  // Distinct from GL because the money never leaves your books — both
  // sides are your own accounts. P&L tools ignore this sheet entirely.
  [SHEETS.TRANSFERS]: [
    { header: "ID", key: "id", width: 16 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Amount", key: "amount", width: 12, style: { numFmt: "#,##0.00" } },
    { header: "Currency", key: "currency", width: 8 },
    { header: "From_Source", key: "from_source", width: 32 },
    { header: "To_Source", key: "to_source", width: 32 },
    { header: "Description", key: "description", width: 40 },
    { header: "Notes", key: "notes", width: 50 },
    // Linked AwaitingPayment (when this Transfer settled an
    // awaiting-transfer row, like a card balance).
    { header: "Awaiting_ID", key: "awaiting_id", width: 16 },
    { header: "Source_File", key: "source_file", width: 50 },
    { header: "Pending_ID", key: "pending_id", width: 16 },
    { header: "Created_At", key: "created_at", width: 22 },
    { header: "Created_By", key: "created_by", width: 12 }, // user | agent | auto-statement
  ],
};

// Seed categories written on first workbook creation. Users edit these
// directly in Excel after that — the ledger is the source of truth, not this
// file. To re-seed an existing ledger, delete the Categories sheet rows or
// blow away the file with `npm run init-ledger`.
export const DEFAULT_CATEGORIES = [
  { name: "Software & Subscriptions", type: "expense", description: "SaaS tools, cloud services, dev tools", account_code: "", active: true },
  { name: "Office Supplies", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Flights", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Hotels", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Meals", type: "expense", description: "", account_code: "", active: true },
  { name: "Travel - Ground Transport", type: "expense", description: "Uber, Lyft, taxis, rental cars", account_code: "", active: true },
  { name: "Meals & Entertainment", type: "expense", description: "Business meals, client entertainment (local)", account_code: "", active: true },
  { name: "Professional Services", type: "expense", description: "Legal, accounting, consulting", account_code: "", active: true },
  { name: "Hardware & Equipment", type: "expense", description: "", account_code: "", active: true },
  { name: "Marketing & Advertising", type: "expense", description: "", account_code: "", active: true },
  { name: "Postage & Shipping", type: "expense", description: "", account_code: "", active: true },
  { name: "Utilities", type: "expense", description: "", account_code: "", active: true },
  { name: "Bank Fees", type: "expense", description: "Flat / punitive charges: late fees, NSF, wires, overdraft", account_code: "", active: true },
  { name: "Interest Expense", type: "expense", description: "Finance charges on revolving card balances and loan interest", account_code: "", active: true },
  { name: "Other / Uncategorized", type: "expense", description: "", account_code: "", active: true },
  // ── Income categories (deposits) ──────────────────────────────────
  { name: "Revenue", type: "income", description: "Customer payments for products / services delivered", account_code: "", active: true },
  { name: "Investor Capital", type: "income", description: "Equity contributions from investors / shareholders", account_code: "", active: true },
  { name: "Loan Proceeds", type: "income", description: "Money received from a loan (a liability — cash-basis bucket)", account_code: "", active: true },
  { name: "Interest Income", type: "income", description: "Bank account interest, money market returns, etc.", account_code: "", active: true },
  { name: "Refund / Reimbursement", type: "income", description: "Vendor refund or customer/partner reimbursement received", account_code: "", active: true },
  { name: "Tax Refund", type: "income", description: "IRS / state / local tax refund received", account_code: "", active: true },
  { name: "Grants", type: "income", description: "Government grants, accelerator stipends, prize money", account_code: "", active: true },
  { name: "Other Income", type: "income", description: "", account_code: "", active: true },
];

// Payment sources are NOT auto-seeded — too user-specific. Users add via Excel
// (or, eventually, a UI). Empty seed avoids steering the parser toward
// fabricated source names.
export const DEFAULT_PAYMENT_SOURCES = [];
