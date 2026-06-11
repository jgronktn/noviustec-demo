// Native Anthropic tool definitions for the bookkeeping agent.
//
// All read-only for Slice 1. The last entry carries cache_control: ephemeral
// so the entire tools block participates in the prompt-cache breakpoint.
// Render order is tools → system → messages — caching the tail of tools is
// enough to cache the whole tools section.

export const TOOL_DEFINITIONS = [
  {
    name: "list_pending",
    description:
      "List receipt entries that have arrived (via email or upload) and are sitting in the inbox awaiting user review. These are NOT yet in the books. Default returns status=pending.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected", "all"],
          description: "Filter by review status. Default: pending.",
        },
      },
    },
  },
  {
    name: "list_transactions",
    description:
      "List rows from the General Ledger (approved expenses). Cash-basis: each row represents money that has moved. Filter by date range, category, or payment source.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        category: {
          type: "string",
          description: "Filter to a single expense category (exact match).",
        },
        payment_source: {
          type: "string",
          description:
            "Filter to a single payment source — credit card, bank, etc.",
        },
      },
    },
  },
  {
    name: "list_awaiting_payment",
    description:
      "List invoices that have been received but NOT yet paid. These are not yet expenses (cash-basis) — they become GL transactions when the receipt arrives and the user matches them. Default returns status=awaiting (still outstanding).",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["awaiting", "paid", "all"],
          description: "Default: awaiting (still outstanding).",
        },
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
      },
    },
  },
  {
    name: "get_pnl",
    description:
      "Get a profit-and-loss summary for a date range. Returns total expense, total transaction count, and per-category breakdown sorted by total descending. Use this for 'how much did we spend' or 'spend by category' questions instead of paginating list_transactions.",
    input_schema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
      },
    },
  },
  {
    name: "get_categories",
    description:
      "List the active chart of accounts (expense categories). Use when the user asks what categories exist or you need to validate a category name.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_payment_sources",
    description:
      "List active payment sources (credit cards, bank accounts). Use when the user asks what sources exist or wants to filter by source.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_documents",
    description:
      "List archived source documents (invoice PDFs, receipt images) attached to a specific transaction or pending entry. Returns metadata only — vendor, date, reference number, filename. The agent cannot read the file contents directly.",
    input_schema: {
      type: "object",
      properties: {
        txn_id: {
          type: "string",
          description: "Filter to documents attached to a GL transaction id.",
        },
        pending_id: {
          type: "string",
          description: "Filter to documents archived for a pending entry id.",
        },
      },
    },
  },

  // ── Render tools ──────────────────────────────────────────────────────────
  // These push a typed panel into the dashboard canvas AND return a small
  // summary to the model. Use them when the user wants to *see* something
  // (charts, tables, headline numbers) — not when they just want a one-line
  // text answer. Don't pair them with the corresponding data tool for the
  // same query; the render tools already fetch the underlying data.

  {
    name: "show_pnl_chart",
    description:
      "Render a P&L breakdown as a horizontal bar chart in the dashboard. Use when the user asks to 'see' or 'show' spend by category for a date range, or wants to compare 4+ categories visually. For a quick text answer about totals, use get_pnl instead.",
    input_schema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        title: {
          type: "string",
          description:
            "Optional title for the panel (e.g. 'P&L — YTD 2026'). Defaults to a date-range string.",
        },
      },
    },
  },
  {
    name: "show_monthly_spend",
    description:
      "Render a vertical bar chart of total spend per month over a date range. Use for 'show monthly spend', 'spend by month', any time the user wants to see month-over-month variation, OR when they want a single vendor's monthly spend (pass `vendor`). Distinct from show_pnl_chart, which groups by category across a single range. Supports include_categories / exclude_categories and an optional `vendor` filter — so 'show monthly spend without professional services', 'show monthly travel spend', and 'show monthly spend for Anthropic' all work in one call. Default range is the trailing 12 months ending today.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive YYYY-MM-DD start. Defaults to the start of the month 12 months ago.",
        },
        to: {
          type: "string",
          description: "Inclusive YYYY-MM-DD end. Defaults to today.",
        },
        vendor: {
          type: "string",
          description:
            "Filter to a single vendor (case-insensitive substring match — 'anthropic' matches 'Anthropic, PBC'). Use for 'show monthly spend for <vendor>' / 'monthly Anthropic spend'.",
        },
        include_categories: {
          type: "array",
          items: { type: "string" },
          description:
            "Only include transactions whose category contains one of these names (case-insensitive substring match — 'travel' matches 'Travel - Flights' and 'Travel - Meals'). Combine with exclude_categories carefully; include wins when both apply.",
        },
        exclude_categories: {
          type: "array",
          items: { type: "string" },
          description:
            "Skip transactions whose category contains one of these names. Use for 'show monthly spend without X'. Case-insensitive substring match.",
        },
        title: {
          type: "string",
          description: "Optional panel title. Defaults to 'Monthly spend' plus a filter description.",
        },
      },
    },
  },
  {
    name: "propose_transaction",
    description:
      "Draft a new GL transaction for the user to approve. Use when the user describes paying someone manually (check, credit card, ACH, wire, cash) and wants it booked into the ledger — phrases like 'book a $42 check to Joe's Garage', 'I paid X for Y', 'add a payment to the ledger', 'log this credit card charge'. NEVER writes to the ledger directly — it renders a draft panel on the canvas with all fields the user can edit, and ONLY the user's Approve click writes the GL row. Fill in everything you can infer from the user's prompt (vendor, amount, date, description, reference_kind); leave gaps blank if you're not sure (the user fills them in). Do NOT use this for paying down an outstanding awaiting invoice (use the Record Payment dialog on the awaiting card instead) or for reconciling a statement line (use the reconciliation panel's Book-as-new instead). If unsure whether the user wants this or one of those flows, ASK.",
    input_schema: {
      type: "object",
      required: ["vendor", "amount"],
      properties: {
        vendor: {
          type: "string",
          description: "Who got paid (e.g. 'Joe's Garage', 'Anthropic, PBC').",
        },
        amount: {
          type: "number",
          description: "Positive dollar amount (the system tracks expenses as positive numbers; sign comes from the GL convention).",
        },
        date: {
          type: "string",
          description: "Payment date as YYYY-MM-DD. Defaults to today if omitted.",
        },
        category: {
          type: "string",
          description: "GL category (exact match to a row in Categories sheet, e.g. 'Bank Fees', 'Office Supplies'). Leave blank if you're not sure — the user picks from a dropdown in the draft panel.",
        },
        payment_source: {
          type: "string",
          description: "Which account/card the payment came from (exact match to a row in Sources, e.g. 'Business Advantage Fundamentals™ Banking ••9934'). Leave blank if not sure.",
        },
        reference_kind: {
          type: "string",
          enum: ["check", "card", "ach", "wire", "cash", "other"],
          description: "How the payment was made. Infer from the user's prompt: 'check' if they say 'check', 'card' for credit card, 'ach' for bank transfer, 'wire' for wire, 'cash' for cash.",
        },
        reference_number: {
          type: "string",
          description: "Optional check number, confirmation number, or other reference id.",
        },
        description: {
          type: "string",
          description: "Short description of what was paid for (e.g. 'car repairs', 'monthly retainer').",
        },
        notes: {
          type: "string",
          description: "Optional longer notes.",
        },
      },
    },
  },
  {
    name: "show_transaction_table",
    description:
      "Render a table of GL transactions in the dashboard. Use when the user wants to inspect individual rows for a date range, category, vendor, or payment source. Caps at 100 rows.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        category: {
          type: "string",
          description: "Filter to a single category (exact match).",
        },
        payment_source: {
          type: "string",
          description: "Filter to a single payment source (exact match).",
        },
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
        title: {
          type: "string",
          description: "Optional title. Defaults to a filter-description string.",
        },
      },
    },
  },
  {
    name: "show_awaiting_table",
    description:
      "Render a table of outstanding (unpaid) invoices in the dashboard. Use when the user wants to see what's owed.",
    input_schema: {
      type: "object",
      properties: {
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_main_timeline",
    description:
      "Render the global activity timeline — every invoice, receipt and payment across every vendor — in the same two-column timeline format as show_vendor_timeline. Use when the user wants the unfiltered, all-vendor view (the default dashboard home screen). Each card shows the vendor name since the view is multi-vendor.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Optional inclusive start date (YYYY-MM-DD).",
        },
        to: {
          type: "string",
          description: "Optional inclusive end date (YYYY-MM-DD).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_category_timeline",
    description:
      "Render the activity timeline for a single spend category — every booked payment and deposit in that category, across ALL vendors, in the same two-column timeline format. Each card shows the vendor name since the view spans multiple vendors. Use when the user wants a category's activity over time: 'show Travel activity', 'timeline for Cloud Infrastructure', 'what's the activity in Office Supplies', 'show me everything in Professional Services'. Category match is case-insensitive and exact, so pass a real category name — call get_categories first if you're unsure which exists. Note: unpaid invoices carry no category, so this view shows booked GL activity (payments + deposits) only.",
    input_schema: {
      type: "object",
      required: ["category"],
      properties: {
        category: {
          type: "string",
          description:
            "Category name, matched case-insensitively against the chart of categories (e.g. 'Cloud Infrastructure').",
        },
        from: {
          type: "string",
          description: "Optional inclusive start date (YYYY-MM-DD).",
        },
        to: {
          type: "string",
          description: "Optional inclusive end date (YYYY-MM-DD).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_vendor_timeline",
    description:
      "Render a two-column vertical timeline for a single vendor — invoices on the left, payments on the right, sorted chronologically. Each event is a card anchored by its date, with subtle color coding (gray = paid, amber = awaiting, red = overdue). A running balance + outstanding-invoice list sits at the top. Use this when the user wants to see the financial relationship with one vendor over time: 'show my Anthropic timeline', 'history with Kroger', 'what's our DigitalOcean relationship look like'. Vendor match is case-insensitive substring.",
    input_schema: {
      type: "object",
      required: ["vendor"],
      properties: {
        vendor: {
          type: "string",
          description:
            "Vendor query. Matches stored vendor names by case-insensitive substring — 'anthropic' matches 'Anthropic, PBC'.",
        },
        from: {
          type: "string",
          description: "Optional inclusive start date (YYYY-MM-DD).",
        },
        to: {
          type: "string",
          description: "Optional inclusive end date (YYYY-MM-DD).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_file_list",
    description:
      "Render a downloadable list of archived files in the dashboard (PDFs and images attached to receipts, invoices, etc., plus the ledger workbook itself). The panel lets the user download individual files or select multiple and download them in bulk. Filter by reference_kind (invoice, receipt, order, transaction, confirmation, other), or use kind='ledger' to surface just the ledger workbook, or omit kind to include everything.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "invoice",
            "receipt",
            "order",
            "transaction",
            "confirmation",
            "other",
            "ledger",
            "all",
          ],
          description:
            "Filter to a document kind, or 'ledger' for the workbook only, or 'all' (default) to include the ledger plus every document.",
        },
        vendor: {
          type: "string",
          description: "Filter to a single vendor (exact match).",
        },
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format.",
        },
        limit: {
          type: "integer",
          description: "Cap to most recent N documents. Default 100.",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "read_statement",
    description:
      "Load a bank or credit-card statement's archived PDF into the conversation so you can answer detailed questions about its actual contents — line-by-line transactions in their raw printed form, vendor names that didn't normalize cleanly during parsing, fee schedules, footnotes, anything visible in the document. Use this only when the user asks something specific that show_statements_list / show_reconciliation / the StatementLines sheet doesn't already answer cleanly. COST: loading a multi-page PDF adds ~2–5k tokens per page to every subsequent turn in the conversation, so don't call it speculatively. Prefer the parsed data first; reach for this when the user asks 'what does the statement actually say about X' or you suspect the parser missed something.",
    input_schema: {
      type: "object",
      required: ["statement_id"],
      properties: {
        statement_id: {
          type: "string",
          description: "Statement id (stmt_xxxxxxxx). Get it from show_statements_list if the user hasn't supplied one.",
        },
      },
    },
  },
  {
    name: "show_reconciliation",
    description:
      "Auto-match a bank/credit-card statement's lines against GL transactions, then render the reconciliation view: matched pairs, unmatched statement lines (split into debits the user still needs to resolve and credits we can't match without an income side), and GL rows in the same payment-source/period that nothing matched against. Use when the user asks to reconcile, match a statement, or wants to know why their statement and books disagree. Source-name diagnostic surfaces the most common cause of misses (statement source like 'Business Advantage Fundamentals™ Banking ••9934' vs GL payment_source like 'BoA Business Checking').",
    input_schema: {
      type: "object",
      properties: {
        statement_id: {
          type: "string",
          description:
            "Statement id (stmt_xxxxxxxx) — get it from show_statements_list if the user hasn't told you. If omitted, the most recent statement is used; pass source as a hint when the user names a specific bank.",
        },
        source: {
          type: "string",
          description:
            "Vendor/bank name fragment — used to pick the most recent statement when statement_id isn't known.",
        },
      },
    },
  },
  {
    name: "show_statements_list",
    description:
      "Render a table of imported bank and credit-card statements (from the Statements sheet — NOT the document archive). Each row shows the statement's source account, period, line count, opening/closing balances, and totals, with a Download button to grab the original PDF. Use this when the user asks to see bank statements, credit-card statements, or 'statements I uploaded'. Filter by status or by source.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "imported", "needs_attention", "reconciled", "partially_reconciled"],
          description: "Filter by status. Default: all.",
        },
        source: {
          type: "string",
          description: "Filter to a single payment source name (exact match).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_statement_timeline",
    description:
      "Render a chronological timeline of bank and credit-card statements — no invoices, no receipts, no GL payments, just statements. Each card shows source, period, statement date, opening/closing balance, total charges/payments, line count, and reconciliation status. Sorted newest-first. Use this when the user wants to see 'statement activity' or 'show me the bank and card statements on the timeline' — distinct from show_statements_list (which is a flat table) and show_vendor_timeline (which mixes invoices and payments).",
    input_schema: {
      type: "object",
      properties: {
        source_kind: {
          type: "string",
          enum: ["all", "credit_card", "bank_account"],
          description: "Filter by kind. Default: all.",
        },
        source: {
          type: "string",
          description: "Filter to a single payment source name (exact match).",
        },
        from: {
          type: "string",
          description: "YYYY-MM-DD: include statements whose statement_date is on or after this.",
        },
        to: {
          type: "string",
          description: "YYYY-MM-DD: include statements whose statement_date is on or before this.",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_deposit_activity",
    description:
      "Render a chronological timeline of deposits (income / money coming in) only — no expense payments, no invoices, no statements. Each card shows source/payer, date, amount, category, and the account it was deposited into. Use this when the user wants to see 'deposit activity', 'show only deposits', 'show me the income', 'deposit timeline'. Distinct from show_vendor_timeline (which shows both expense and income side-by-side) and show_monthly_spend (which is expense by month). Supports optional vendor (source/payer), category, and date-range filters.",
    input_schema: {
      type: "object",
      properties: {
        vendor: {
          type: "string",
          description:
            "Filter to a single source/payer (case-insensitive substring match — 'stripe' matches 'Stripe Inc').",
        },
        category: {
          type: "string",
          description:
            "Filter to a single income category (exact name, e.g. 'Revenue', 'Investor Capital', 'Interest Income').",
        },
        from: {
          type: "string",
          description: "Inclusive YYYY-MM-DD start. Defaults to trailing 12 months.",
        },
        to: {
          type: "string",
          description: "Inclusive YYYY-MM-DD end. Defaults to today.",
        },
        title: {
          type: "string",
          description: "Optional panel title.",
        },
      },
    },
  },
  {
    name: "show_inbox_list",
    description:
      "Render a table of all items received in the inbox (receipts that arrived via email or upload). Shows pending, approved, and rejected entries together so the user can see the full history of what's come in. Default returns all statuses, newest first. Cap at 100 rows.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected", "all"],
          description: "Filter by status. Default: all.",
        },
        limit: {
          type: "integer",
          description: "Cap to most recent N entries. Default: 100.",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_vendor_breakdown",
    description:
      "Render a per-vendor spend breakdown as a horizontal bar list in the dashboard. Use when the user asks to 'see' / 'list' / 'show' vendors, who they're spending the most with, or wants a vendor leaderboard. Cash-basis: only counts approved GL transactions.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Inclusive start date in YYYY-MM-DD format. Omit for all-time.",
        },
        to: {
          type: "string",
          description: "Inclusive end date in YYYY-MM-DD format. Omit for all-time.",
        },
        category: {
          type: "string",
          description: "Filter to vendors used within a single category (exact match).",
        },
        limit: {
          type: "integer",
          description: "Cap to top N vendors by total spend. Defaults to all vendors (capped at 50).",
        },
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
  },
  {
    name: "show_category_manager",
    description:
      "Open the category manager — an editable panel listing the chart of categories where the user can add, rename, change type, and archive/restore categories directly. Use when the user wants to 'manage categories', 'edit my categories', 'see and change the categories', or add/clean up several at once.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Optional title." },
      },
    },
  },
  {
    name: "add_category",
    description:
      "Add a new category to the chart of categories. Idempotent on name (no-op if it already exists). Use for 'add a category called Travel', 'create a Marketing category'. Default type is 'expense'; use 'revenue' for income categories and 'transfer' for internal money movement.",
    input_schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Category name, e.g. 'Travel & Meals'.",
        },
        type: {
          type: "string",
          enum: ["expense", "revenue", "transfer"],
          description: "Category type. Default 'expense'.",
        },
        description: { type: "string", description: "Optional description." },
      },
    },
  },
  {
    name: "update_category",
    description:
      "Edit an existing category: rename it, change its type/description, or archive/restore it. Use for 'archive Office Supplies' (active=false), 'restore Travel' (active=true), 'rename X to Y' (new_name), or 'make Software a revenue category'. Renaming cascades across booked transactions so history follows the new name. Prefer archiving over deleting — there is no delete.",
    input_schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "The category's CURRENT name (the one to edit).",
        },
        new_name: { type: "string", description: "New name, if renaming." },
        type: {
          type: "string",
          enum: ["expense", "revenue", "transfer"],
          description: "New type, if changing.",
        },
        description: {
          type: "string",
          description: "New description, if changing.",
        },
        active: {
          type: "boolean",
          description:
            "false = archive (hide from dropdowns), true = restore.",
        },
      },
    },
  },
  {
    name: "show_kpi_summary",
    description:
      "Render a headline KPI tile grid in the dashboard (pending count, YTD spend, outstanding total, recent transaction count). Use when the user asks for an overview / 'how are we doing' / 'state of the books'. Always queries the current state — does not take a date range.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional title.",
        },
      },
    },
    cache_control: { type: "ephemeral" },
  },
];
