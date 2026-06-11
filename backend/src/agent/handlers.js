// Tool dispatcher for the bookkeeping agent.
//
// Maps Anthropic tool_use names to the existing ledger read functions, with
// light post-processing (date → ISO string, group-by for P&L, scrub
// filesystem paths). Returns plain JSON-serializable objects.

import * as path from "node:path";
import { promises as fs } from "node:fs";
import {
  listPending,
  listTransactions,
  listAwaiting,
  getCategories,
  addCategory,
  updateCategory,
  getPaymentSources,
  listDocuments,
  listStatements,
  listStatementLines,
  listTransfers,
  getStatement,
  getLedgerPath,
} from "../ledger/index.js";
import {
  autoMatchStatement,
  buildReconciliationView,
  findStatementBySource,
} from "../reconciliation/index.js";
import { resolveStatementPath } from "../storage/documents.js";

const AGENT_COMPANY_ID = process.env.NOVIUSTEC_COMPANY_ID || "default";

function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    // dates already in YYYY-MM-DD pass through; ISO strings get truncated
    return v.length >= 10 ? v.slice(0, 10) : v;
  }
  // Excel numeric serial date (days since 1900-01-01, with Excel's
  // 1900-leap-year fiction). ExcelJS occasionally hands these back when
  // cells were written with date-formatted styling but a raw number value
  // — happens to legacy AwaitingPayment rows written before the schema
  // standardized on Date objects. Without this branch those rows fall
  // through to null and get silently filtered out of the timeline.
  if (typeof v === "number" && Number.isFinite(v) && v > 1) {
    // Excel epoch correction: Excel day 25569 = 1970-01-01 (Unix epoch).
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function scrubTransaction(r) {
  return {
    id: r.id,
    date: isoDate(r.date),
    vendor: r.vendor,
    description: r.description ?? "",
    category: r.category,
    payment_source: r.payment_source ?? null,
    amount: r.amount,
    currency: r.currency ?? "USD",
    reference_number: r.reference_number ?? null,
    reference_kind: r.reference_kind ?? null,
    notes: r.notes ?? "",
  };
}

function scrubAwaiting(r) {
  return {
    id: r.id,
    status: r.status,
    vendor: r.vendor,
    date: isoDate(r.date),
    amount: r.amount,
    currency: r.currency ?? "USD",
    reference_number: r.reference_number ?? null,
    reference_kind: r.reference_kind ?? null,
    description: r.description ?? "",
    paid_at: r.paid_at ?? null,
    paid_txn_id: r.paid_txn_id ?? null,
  };
}

function scrubPending(r) {
  return {
    id: r.id,
    status: r.status,
    vendor: r.vendor,
    date: isoDate(r.date),
    total: r.total,
    currency: r.currency ?? "USD",
    suggested_category: r.suggested_category ?? null,
    confidence: r.confidence ?? null,
    reference_number: r.reference_number ?? null,
    reference_kind: r.reference_kind ?? null,
    reason: r.reason ?? null,
  };
}

function scrubDocument(r) {
  return {
    id: r.id,
    vendor: r.vendor,
    date: isoDate(r.date),
    reference_kind: r.reference_kind ?? null,
    reference_number: r.reference_number ?? null,
    filename: r.filename,
    original_filename: r.original_filename ?? null,
    txn_id: r.txn_id ?? null,
    pending_id: r.pending_id ?? null,
    awaiting_id: r.awaiting_id ?? null,
  };
}

async function computePnl({ from, to }) {
  if (!from || !to) {
    throw new Error("get_pnl requires both 'from' and 'to' (YYYY-MM-DD)");
  }
  const rows = await listTransactions({ from, to });
  const buckets = new Map();
  let totalExpense = 0;
  for (const r of rows) {
    const cat = r.category || "(uncategorized)";
    const amount = Number(r.amount) || 0;
    totalExpense += amount;
    const b = buckets.get(cat) ?? { category: cat, total: 0, count: 0 };
    b.total += amount;
    b.count += 1;
    buckets.set(cat, b);
  }
  const totals_by_category = [...buckets.values()]
    .map((b) => ({ ...b, total: Math.round(b.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
  return {
    period: { from, to },
    count: rows.length, // mirrors total_count so the UI pill shows N transactions
    total_count: rows.length,
    total_expense: Math.round(totalExpense * 100) / 100,
    totals_by_category,
  };
}

// Case-insensitive substring vendor match. Lets the user say "Anthropic"
// and find rows stored as "Anthropic, PBC", or "kroger" → "Kroger". Used
// by every show_* tool that takes a vendor filter — exact-match was a
// footgun whenever a vendor's stored name had extra suffixes or commas.
function vendorMatches(rowVendor, query) {
  if (!query) return true;
  if (!rowVendor) return false;
  return rowVendor.toLowerCase().includes(query.toLowerCase());
}

function describeFilters({ from, to, category, payment_source, vendor }) {
  const parts = [];
  if (from && to) parts.push(`${from} – ${to}`);
  else if (from) parts.push(`from ${from}`);
  else if (to) parts.push(`through ${to}`);
  if (category) parts.push(`category=${category}`);
  if (payment_source) parts.push(`source=${payment_source}`);
  if (vendor) parts.push(`vendor=${vendor}`);
  return parts.join(" · ");
}

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

const TXN_TABLE_LIMIT = 100;

const TIMELINE_OVERDUE_DAYS = 30;

// reference_kind values that describe the payment METHOD, not a
// document/artifact from the vendor. These never get a left-side
// "doc fallback" card on the timeline — the left side is for
// invoices/receipts/orders the vendor sent, not the mechanism we
// used to pay. Used by buildTimelineProps.
const PAYMENT_METHOD_KINDS = new Set([
  "check",
  "card",
  "ach",
  "wire",
  "cash",
]);

/**
 * Build the timeline panel payload. Used by:
 *  - show_vendor_timeline (agent tool, vendor required)
 *  - show_main_timeline   (agent tool, vendor null — all vendors)
 *  - GET /api/main-timeline (direct HTTP route for the dashboard home screen)
 *
 * When `vendor` is null/empty, every vendor's events appear and the panel
 * renders in "global mode" (vendor name shown on each card).
 */
export async function buildTimelineProps({ vendor = null, category = null, from, to } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  const awaitingAll = await listAwaiting({ status: "all" });
  const txnAll = await listTransactions({ from, to });
  // Pre-fetch every Documents row so the timeline can render one left-side
  // card per archived doc instead of just one per GL row. Anthropic emails
  // ship an invoice PDF and a receipt PDF together — both belong on the
  // timeline as separate events tied to the same payment.
  const docsAll = await listDocuments();
  // Pre-fetch every StatementLine so right-side cards can show a
  // green check when reconciled against a statement (card or bank). A GL
  // txn is "statement-matched" iff at least one StatementLine.matched_txn_id
  // points at it; same for transfers via matched_transfer_id. Cheap to
  // load — used to drive UI ticks, not for matching itself.
  const statementLinesAll = await listStatementLines();
  const txnIdsMatchedOnStatement = new Set(
    statementLinesAll
      .filter((l) => l.matched_txn_id)
      .map((l) => l.matched_txn_id),
  );
  const transferIdsMatchedOnStatement = new Set(
    statementLinesAll
      .filter((l) => l.matched_transfer_id)
      .map((l) => l.matched_transfer_id),
  );

  // Transfers in the period — feed both the right-side cards (in-range
  // only) and the left-side awaiting cards (regardless of date — a
  // settling transfer can be outside the current timeline window and
  // still close the loop). Load unfiltered, then derive the in-range
  // subset.
  const transferAllUnfiltered = await listTransfers();
  const transferAll = transferAllUnfiltered.filter((t) => {
    const iso = isoDate(t.date);
    if (!iso) return false;
    if (from && iso < from) return false;
    if (to && iso > to) return false;
    return true;
  });

  // awaiting_id → array of Transfer rows that point at it. Used to
  // compute the awaiting's statement_matched flag across ANY of its
  // settling transfers (sum-match means N transfers can settle one
  // awaiting). Uses the unfiltered list so the linkage check isn't
  // sensitive to the timeline's date window.
  const transfersByAwaiting = new Map();
  for (const t of transferAllUnfiltered) {
    if (!t.awaiting_id) continue;
    if (!transfersByAwaiting.has(t.awaiting_id)) {
      transfersByAwaiting.set(t.awaiting_id, []);
    }
    transfersByAwaiting.get(t.awaiting_id).push(t);
  }
  // Group docs by their GL transaction id. Skip docs that are ALSO tied to
  // an AwaitingPayment row: those already get a left card from the awaiting
  // side (drawn on the invoice's date, not the payment date), and we don't
  // want to double-show the same doc on the GL date too.
  const docsByTxn = new Map();
  for (const d of docsAll) {
    if (!d.txn_id) continue;
    if (d.awaiting_id) continue;
    if (!d.reference_kind) continue;
    if (!docsByTxn.has(d.txn_id)) docsByTxn.set(d.txn_id, []);
    docsByTxn.get(d.txn_id).push(d);
  }

  // Category view: filter the booked-GL side (only payments + deposits carry
  // a category) to the requested category across ALL vendors. Invoices have
  // no category column, so a category timeline excludes the awaiting/left
  // side — it's a "where did this category's money actually go" view.
  const catLc = category ? category.trim().toLowerCase() : null;
  const txnInCategory = (r) =>
    !catLc || String(r.category || "").toLowerCase() === catLc;

  const matchedAwaiting = category
    ? []
    : vendor
      ? awaitingAll.filter((r) => vendorMatches(r.vendor, vendor))
      : awaitingAll;
  const matchedTxns = category
    ? txnAll.filter(txnInCategory)
    : vendor
      ? txnAll.filter((r) => vendorMatches(r.vendor, vendor))
      : txnAll;

  const inRange = (d) => {
    const iso = isoDate(d);
    if (!iso) return false;
    if (from && iso < from) return false;
    if (to && iso > to) return false;
    return true;
  };

  // Left-side events (document side: invoices and receipts).
  //
  // Each event carries a `link_id` that groups it with the payment card
  // (and any sibling receipt/invoice card) for the same underlying GL
  // transaction. The frontend uses this to highlight invoice ↔ payment
  // pairs when the user clicks either side. link_id is null when there's
  // no payment yet (unpaid invoice).
  const leftEvents = [];

  for (const r of matchedAwaiting) {
    if (!inRange(r.date)) continue;
    const date = isoDate(r.date);
    const isPaid = r.status === "paid";
    const daysOut =
      !isPaid && date ? Math.max(0, daysBetween(date, today)) : null;
    let status = r.status;
    if (
      status === "awaiting" &&
      daysOut != null &&
      daysOut > TIMELINE_OVERDUE_DAYS
    ) {
      status = "overdue";
    }
    // payment_kind="transfer" awaiting rows are card-balance obligations
    // — the closing balance auto-created at statement import. They live
    // on the left for now (it IS an obligation that needs settling), but
    // get a distinct visual treatment in the frontend so they don't read
    // as a vendor invoice.
    const isTransferObligation = r.payment_kind === "transfer";
    // The awaiting card is "statement-matched" when its settling
    // artifact is itself matched on some StatementLine. With sum-match,
    // an awaiting can be settled by MULTIPLE Transfers (each linked
    // via Transfer.awaiting_id) — the check fires if ANY of those
    // transfers is statement-matched. The full loop is closed:
    // obligation → payments → statement reconciliation.
    const linkedTransfers = transfersByAwaiting.get(r.id) ?? [];
    const awaitingStatementMatched =
      (r.paid_txn_id && txnIdsMatchedOnStatement.has(r.paid_txn_id)) ||
      (r.paid_transfer_id &&
        transferIdsMatchedOnStatement.has(r.paid_transfer_id)) ||
      linkedTransfers.some((t) =>
        transferIdsMatchedOnStatement.has(t.id),
      );
    leftEvents.push({
      id: r.id,
      kind: r.reference_kind || "invoice",
      payment_kind: r.payment_kind || "expense",
      is_transfer_obligation: isTransferObligation,
      date,
      amount: Math.round(Number(r.amount) * 100) / 100,
      currency: r.currency ?? "USD",
      reference_number: r.reference_number ?? null,
      status,
      days_outstanding: daysOut,
      paid_at: r.paid_at
        ? typeof r.paid_at === "string"
          ? r.paid_at.slice(0, 10)
          : new Date(r.paid_at).toISOString().slice(0, 10)
        : null,
      paid_txn_id: r.paid_txn_id ?? null,
      paid_transfer_id: r.paid_transfer_id ?? null,
      link_id: r.paid_txn_id ?? r.paid_transfer_id ?? null,
      description: r.description ?? "",
      vendor: r.vendor,
      source: "awaiting",
      statement_matched: !!awaitingStatementMatched,
    });
  }

  // Left-side cards from the GL side. If the GL row has Documents rows
  // attached (parser-archived PDFs/images), emit ONE left card per doc —
  // so an Anthropic email shipping both an Invoice-XXX.pdf and a
  // Receipt-YYY.pdf renders as two left cards next to one payment card,
  // each tagged with its own reference_kind + reference_number. Fall back
  // to a synthetic card built from the GL row itself when no Documents
  // rows are attached (Record-payment flow with no archived PDF, etc.).
  for (const r of matchedTxns) {
    const date = isoDate(r.date);
    const amount = Math.round(Number(r.amount) * 100) / 100;
    const docs = docsByTxn.get(r.id) ?? [];

    if (docs.length > 0) {
      for (const d of docs) {
        leftEvents.push({
          id: d.id, // Documents row ids are unique across the sheet
          txn_id: r.id, // for dedupe + click → edit-transaction routing
          doc_id: d.id,
          kind: d.reference_kind,
          date,
          amount,
          currency: r.currency ?? "USD",
          reference_number: d.reference_number ?? null,
          status: "paid",
          days_outstanding: null,
          paid_at: date,
          paid_txn_id: r.id,
          link_id: r.id,
          description: r.description ?? "",
          vendor: r.vendor,
          source: "gl",
        });
      }
      continue;
    }

    // Income rows (deposits) never get a left-side card — the left
    // side is for vendor-issued artifacts (invoices/receipts from
    // someone WE owe money to). A deposit is money coming in; no
    // vendor invoice corresponds to it.
    if (r.entry_type === "income") continue;
    // Fallback: no doc rows for this txn (Record-payment with no source
    // PDF, or an old GL row archived before the Documents sheet existed).
    // Skip if the GL row itself has no reference_kind — nothing to show.
    if (!r.reference_kind) continue;
    // Skip payment-method kinds. These describe HOW the money moved
    // (check, card, ACH, wire, cash), not a paper artifact from the
    // vendor — emitting a left card for them double-counts the payment
    // (already on the right side as the GL row). The fallback exists
    // to surface artifacts like invoices/receipts/orders that arrived
    // without a Documents sheet entry.
    if (PAYMENT_METHOD_KINDS.has(String(r.reference_kind).toLowerCase())) {
      continue;
    }
    leftEvents.push({
      id: `${r.id}-doc`,
      txn_id: r.id,
      kind: r.reference_kind,
      date,
      amount,
      currency: r.currency ?? "USD",
      reference_number: r.reference_number ?? null,
      status: "paid",
      days_outstanding: null,
      paid_at: date,
      paid_txn_id: r.id,
      link_id: r.id,
      description: r.description ?? "",
      vendor: r.vendor,
      source: "gl",
    });
  }

  const rightEvents = matchedTxns.map((r) => {
    // Income rows are deposits, not vendor payments; the frontend
    // colors them green and routes their amount into the "deposits in"
    // total instead of "payments out". Legacy/null entry_type → expense.
    const entryType = r.entry_type === "income" ? "income" : "expense";
    return {
      id: r.id,
      kind: entryType === "income" ? "deposit" : "payment",
      entry_type: entryType,
      date: isoDate(r.date),
      amount: Math.round(Number(r.amount) * 100) / 100,
      currency: r.currency ?? "USD",
      reference_number: r.reference_number ?? null,
      reference_kind: r.reference_kind ?? null,
      description: r.description ?? "",
      category: r.category ?? null,
      payment_source: r.payment_source ?? null,
      vendor: r.vendor,
      link_id: r.id,
      statement_matched: txnIdsMatchedOnStatement.has(r.id),
    };
  });

  // Right-side Transfer cards. For a vendor-filtered timeline only include
  // transfers whose linked awaiting matches the vendor (the awaiting's
  // vendor IS the counterparty account — e.g. a card source — and that's
  // what shows up in the awaiting's left-side card). For the global
  // (all-vendor) timeline include every transfer in the period.
  //
  // Vendor display: transfers don't have a vendor field; for the global
  // view we synthesize one from the destination account so the card has
  // something to label. The frontend renders this in the card-vendor slot.
  const awaitingByIdQuick = new Map(awaitingAll.map((a) => [a.id, a]));
  // Transfers carry no category, so a category timeline omits them entirely.
  const matchedTransfers = category
    ? []
    : transferAll.filter((t) => {
        if (!vendor) return true;
        if (!t.awaiting_id) return false;
        const aw = awaitingByIdQuick.get(t.awaiting_id);
        return aw && vendorMatches(aw.vendor, vendor);
      });

  for (const t of matchedTransfers) {
    const linkedAwaiting = t.awaiting_id
      ? awaitingByIdQuick.get(t.awaiting_id)
      : null;
    rightEvents.push({
      id: t.id,
      kind: "transfer",
      date: isoDate(t.date),
      amount: Math.round(Number(t.amount) * 100) / 100,
      currency: t.currency ?? "USD",
      reference_number: null,
      reference_kind: null,
      description: t.description ?? "",
      category: null,
      payment_source: t.from_source ?? null,
      to_source: t.to_source ?? null,
      from_source: t.from_source ?? null,
      // Use the destination account as the "vendor" so the global-mode
      // timeline has something to label the card with.
      vendor: t.to_source ?? "Transfer",
      // If the transfer settles an awaiting, share its link_id so any
      // future pair-highlight logic can find both sides.
      link_id: linkedAwaiting ? linkedAwaiting.id : t.id,
      awaiting_id: t.awaiting_id ?? null,
      statement_matched: transferIdsMatchedOnStatement.has(t.id),
    });
  }

  // ── Bank statements as right-side informational cards ────────────
  // Only on the unfiltered global timeline. Statements have no vendor or
  // category, so they don't belong under a vendor- or category-filtered
  // view. They're informational — never count toward Payments out / Income
  // totals or payment_count / deposit_count.
  if (!vendor && !category) {
    const allStmts = await listStatements({ status: "all" });
    const sources = await getPaymentSources({ activeOnly: false });
    const last4Of = (s) => {
      if (!s) return null;
      const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
      return m ? m[1] : null;
    };
    const SPECIFIC = new Set(["credit_card", "bank_account"]);
    function isBank(stmt) {
      // Resolve via the same backfill heuristic used by
      // show_statement_timeline so legacy statements without a
      // source_kind still classify correctly.
      const declared = stmt.source_kind;
      if (SPECIFIC.has(declared)) return declared === "bank_account";
      const exact = sources.find((s) => s.name === stmt.source);
      if (exact?.type && SPECIFIC.has(exact.type)) {
        return exact.type === "bank_account";
      }
      const stmtLast4 = last4Of(stmt.source);
      if (stmtLast4) {
        const byLast4 = sources.find(
          (s) => last4Of(s.name) === stmtLast4 && SPECIFIC.has(s.type),
        );
        if (byLast4) return byLast4.type === "bank_account";
      }
      const lower = String(stmt.source || "").toLowerCase();
      if (/\b(banking|bank account|checking|savings)\b/.test(lower)) {
        return true;
      }
      return false;
    }
    for (const stmt of allStmts) {
      if (!isBank(stmt)) continue;
      const date = isoDate(stmt.statement_date) || isoDate(stmt.period_end);
      if (!date) continue;
      if (from && date < from) continue;
      if (to && date > to) continue;
      rightEvents.push({
        id: stmt.id,
        kind: "statement",
        date,
        amount:
          stmt.closing_balance == null
            ? 0
            : Math.round(Math.abs(Number(stmt.closing_balance)) * 100) / 100,
        currency: stmt.currency ?? "USD",
        reference_number: stmt.original_filename || stmt.id,
        reference_kind: "statement",
        description: `${isoDate(stmt.period_start) ?? "?"} → ${isoDate(stmt.period_end) ?? "?"}`,
        category: null,
        payment_source: stmt.source,
        vendor: stmt.source,
        link_id: stmt.id,
        statement_matched: stmt.status === "reconciled",
      });
    }
  }

  const dateSet = new Set([
    ...leftEvents.map((e) => e.date).filter(Boolean),
    ...rightEvents.map((e) => e.date).filter(Boolean),
  ]);
  const rows = [...dateSet]
    .sort((a, b) => b.localeCompare(a))
    .map((d) => ({
      date: d,
      left: leftEvents.filter((e) => e.date === d),
      right: rightEvents.filter((e) => e.date === d),
    }));

  // Totals reflect external business activity only — vendor invoices and
  // vendor payments. The transfer-kind artifacts (auto-created Card
  // balance awaitings and the inter-account Transfer cards that settle
  // them) are EXCLUDED because they are internal money movements: the
  // underlying expenses they sum/settle are already counted via the
  // individual GL transactions on the right side. Including them would
  // double-count every credit-card statement cycle.
  const totalInvoiced = leftEvents
    .filter((e) => e.source === "awaiting" && !e.is_transfer_obligation)
    .reduce((s, e) => s + e.amount, 0);
  // Split the right-side total into payments-out (expense GL rows)
  // and deposits-in (income GL rows). Transfer and Statement cards
  // are excluded from both — transfers because they're internal
  // money moves, statements because they're informational only.
  const totalPaid = rightEvents
    .filter(
      (e) =>
        e.kind !== "transfer" &&
        e.kind !== "statement" &&
        e.entry_type !== "income",
    )
    .reduce((s, e) => s + e.amount, 0);
  const totalDeposits = rightEvents
    .filter((e) => e.entry_type === "income")
    .reduce((s, e) => s + e.amount, 0);
  // Totals dedupe across overlapping representations of the same money:
  //   - Awaiting card always counts (one per AwaitingPayment row), EXCEPT
  //     Card balance awaitings (transfer obligations) — see above.
  //   - GL doc cards on a txn that paid an awaiting → skipped (the
  //     awaiting card already covers that money).
  //   - GL doc cards on an unpaid-via-awaiting txn → count the GL row's
  //     amount ONCE per txn, regardless of how many doc cards we drew
  //     for it (Anthropic ships invoice + receipt = 2 cards, 1 txn).
  const paidTxnIds = new Set(
    matchedAwaiting
      .filter((r) => r.paid_txn_id)
      .map((r) => r.paid_txn_id),
  );
  const totalLeft = (() => {
    let total = 0;
    const countedTxns = new Set();
    for (const e of leftEvents) {
      if (e.source === "awaiting") {
        if (e.is_transfer_obligation) continue; // Card balance — internal
        total += e.amount;
        continue;
      }
      // e.source === "gl"
      const txnId = e.txn_id ?? e.id.replace(/-doc$/, "");
      if (!txnId) continue;
      if (paidTxnIds.has(txnId)) continue; // awaiting already counted this money
      if (countedTxns.has(txnId)) continue; // already counted from a sibling doc card
      countedTxns.add(txnId);
      total += e.amount;
    }
    return total;
  })();
  const totalRight = totalPaid;
  const outstandingInvoices = leftEvents
    .filter(
      (e) =>
        e.source === "awaiting" &&
        !e.is_transfer_obligation &&
        (e.status === "awaiting" || e.status === "overdue"),
    )
    .map((e) => ({
      id: e.id,
      vendor: e.vendor,
      reference_number: e.reference_number,
      date: e.date,
      amount: e.amount,
      days_outstanding: e.days_outstanding,
      overdue: e.status === "overdue",
    }));
  const outstandingBalance = outstandingInvoices.reduce(
    (s, i) => s + i.amount,
    0,
  );

  const vendorCounts = new Map();
  for (const e of [...leftEvents, ...rightEvents]) {
    vendorCounts.set(e.vendor, (vendorCounts.get(e.vendor) ?? 0) + 1);
  }
  const distinctVendors = vendorCounts.size;
  const canonicalVendor = vendor
    ? [...vendorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? vendor
    : null;
  // Display name for a category view: prefer the canonical stored casing
  // from a matched row, falling back to the requested string.
  const canonicalCategory = category
    ? matchedTxns[0]?.category ?? category
    : null;

  return {
    vendor: canonicalVendor,
    query: vendor || null,
    // is_global = the truly unfiltered, all-vendor view. A category view is
    // multi-vendor but scoped, so it's NOT global — it gets its own flag.
    is_global: !vendor && !category,
    is_category: !!category,
    category: canonicalCategory,
    period: { from: from ?? null, to: to ?? null },
    rows,
    summary: {
      total_invoiced: Math.round(totalInvoiced * 100) / 100,
      total_paid: Math.round(totalPaid * 100) / 100,
      total_deposits: Math.round(totalDeposits * 100) / 100,
      // Net cash flow over the period: income minus expenses.
      // Positive = money came in net, negative = money went out net.
      total_cash: Math.round((totalDeposits - totalPaid) * 100) / 100,
      total_left: Math.round(totalLeft * 100) / 100,
      total_right: Math.round(totalRight * 100) / 100,
      outstanding_balance: Math.round(outstandingBalance * 100) / 100,
      // Same exclusion rule as totalLeft/totalRight: counts reflect
      // external (vendor-facing) activity only. Card balance awaitings
      // and Transfer cards represent internal money moves and are
      // counted separately if the UI ever wants them.
      invoice_count: leftEvents.filter(
        (e) => e.source === "awaiting" && !e.is_transfer_obligation,
      ).length,
      payment_count: rightEvents.filter(
        (e) =>
          e.kind !== "transfer" &&
          e.kind !== "statement" &&
          e.entry_type !== "income",
      ).length,
      deposit_count: rightEvents.filter((e) => e.entry_type === "income")
        .length,
      statement_count: rightEvents.filter((e) => e.kind === "statement")
        .length,
      awaiting_count: leftEvents.filter(
        (e) => e.status === "awaiting" && !e.is_transfer_obligation,
      ).length,
      overdue_count: leftEvents.filter(
        (e) => e.status === "overdue" && !e.is_transfer_obligation,
      ).length,
      // Optional surface for the UI if it wants to expose the internal
      // totals separately (e.g. a "Card balances" / "Transfers" footer).
      transfer_obligation_count: leftEvents.filter(
        (e) => e.is_transfer_obligation,
      ).length,
      transfer_count: rightEvents.filter((e) => e.kind === "transfer").length,
      distinct_vendors: distinctVendors,
      outstanding_invoices: outstandingInvoices,
      overdue_days_threshold: TIMELINE_OVERDUE_DAYS,
      as_of: today,
    },
  };
}

export async function runTool(name, input) {
  const args = input ?? {};
  switch (name) {
    case "list_pending": {
      const rows = await listPending({ status: args.status ?? "pending" });
      return { count: rows.length, entries: rows.map(scrubPending) };
    }
    case "list_transactions": {
      const rows = await listTransactions({
        from: args.from,
        to: args.to,
        category: args.category,
        payment_source: args.payment_source,
      });
      return { count: rows.length, transactions: rows.map(scrubTransaction) };
    }
    case "list_awaiting_payment": {
      let rows = await listAwaiting({ status: args.status ?? "awaiting" });
      if (args.vendor)
        rows = rows.filter((r) => vendorMatches(r.vendor, args.vendor));
      return { count: rows.length, entries: rows.map(scrubAwaiting) };
    }
    case "get_pnl": {
      return computePnl({ from: args.from, to: args.to });
    }
    case "get_categories": {
      const categories = await getCategories({ activeOnly: true });
      return { count: categories.length, categories };
    }
    case "get_payment_sources": {
      const sources = await getPaymentSources({ activeOnly: true });
      return { count: sources.length, sources };
    }
    case "list_documents": {
      const rows = await listDocuments({
        txn_id: args.txn_id,
        pending_id: args.pending_id,
      });
      return { count: rows.length, documents: rows.map(scrubDocument) };
    }

    // ── Render tools ─────────────────────────────────────────────────────
    // Each returns `{ __panel: { kind, title, props }, ...summary }`. The
    // loop strips __panel out, yields it as a `panel` SSE event, and
    // sends the rest to the model as the tool_result.

    case "show_monthly_spend": {
      // Default range: trailing 12 months ending today.
      const today = new Date();
      const defaultTo = today.toISOString().slice(0, 10);
      const past = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1),
      );
      const defaultFrom = past.toISOString().slice(0, 10);
      const from = args.from || defaultFrom;
      const to = args.to || defaultTo;

      let txns = await listTransactions({ from, to });

      // Vendor filter — same case-insensitive substring shape used
      // everywhere else in the agent ('anthropic' matches 'Anthropic, PBC').
      if (args.vendor) {
        txns = txns.filter((t) => vendorMatches(t.vendor, args.vendor));
      }

      // Case-insensitive substring category filters — so 'travel'
      // matches 'Travel - Flights', 'Travel - Meals', etc.
      const include = (args.include_categories ?? []).map((c) =>
        String(c).toLowerCase(),
      );
      const exclude = (args.exclude_categories ?? []).map((c) =>
        String(c).toLowerCase(),
      );
      if (include.length > 0) {
        txns = txns.filter((t) =>
          include.some((inc) =>
            String(t.category || "").toLowerCase().includes(inc),
          ),
        );
      }
      if (exclude.length > 0) {
        txns = txns.filter(
          (t) =>
            !exclude.some((exc) =>
              String(t.category || "").toLowerCase().includes(exc),
            ),
        );
      }

      // Pre-populate every month in range so empty months render as
      // zero-height bars — time passing is part of the story.
      const months = new Map(); // YYYY-MM → { month, total, count }
      const start = new Date(from);
      let cursor = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
      );
      const end = new Date(to);
      while (cursor <= end) {
        const ym = cursor.toISOString().slice(0, 7);
        months.set(ym, { month: ym, total: 0, count: 0 });
        cursor = new Date(
          Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
        );
      }

      for (const t of txns) {
        const d = isoDate(t.date);
        if (!d) continue;
        const ym = d.slice(0, 7);
        if (!months.has(ym)) {
          months.set(ym, { month: ym, total: 0, count: 0 });
        }
        const bucket = months.get(ym);
        bucket.total += Math.abs(Number(t.amount) || 0);
        bucket.count += 1;
      }

      const sorted = [...months.values()].sort((a, b) =>
        a.month.localeCompare(b.month),
      );
      for (const m of sorted) m.total = Math.round(m.total * 100) / 100;

      const totalSpend = sorted.reduce((s, m) => s + m.total, 0);
      const totalCount = sorted.reduce((s, m) => s + m.count, 0);
      const active = sorted.filter((m) => m.total > 0);
      const avg = active.length > 0 ? totalSpend / active.length : 0;
      const peak = sorted.reduce(
        (acc, m) => (m.total > (acc?.total ?? -1) ? m : acc),
        null,
      );

      const filterParts = [];
      if (args.vendor) filterParts.push(`vendor=${args.vendor}`);
      if (include.length > 0)
        filterParts.push(`only ${args.include_categories.join(", ")}`);
      if (exclude.length > 0)
        filterParts.push(`excluding ${args.exclude_categories.join(", ")}`);
      const filterDesc = filterParts.join(" · ");
      const title =
        args.title ??
        (filterDesc ? `Monthly spend · ${filterDesc}` : "Monthly spend");

      return {
        __panel: {
          kind: "monthly_spend_chart",
          title,
          props: {
            months: sorted,
            period: { from, to },
            filters: {
              vendor: args.vendor ?? null,
              include: args.include_categories ?? [],
              exclude: args.exclude_categories ?? [],
            },
            summary: {
              total_spend: Math.round(totalSpend * 100) / 100,
              total_count: totalCount,
              months_with_activity: active.length,
              average_per_active_month: Math.round(avg * 100) / 100,
              peak_month: peak?.month ?? null,
              peak_amount: peak?.total ?? 0,
            },
          },
        },
        period: { from, to },
        total_spend: Math.round(totalSpend * 100) / 100,
        total_count: totalCount,
        months: sorted.map((m) => ({
          month: m.month,
          total: m.total,
          count: m.count,
        })),
      };
    }

    case "show_pnl_chart": {
      const pnl = await computePnl({ from: args.from, to: args.to });
      const title = args.title ?? `P&L · ${args.from} – ${args.to}`;
      return {
        __panel: { kind: "pnl_chart", title, props: pnl },
        period: pnl.period,
        total_expense: pnl.total_expense,
        total_count: pnl.total_count,
        categories: pnl.totals_by_category.length,
        top_category:
          pnl.totals_by_category[0]?.category ?? null,
      };
    }

    case "propose_transaction": {
      // No ledger write. Just package the agent's proposed values into
      // a draft panel for the user to review, edit, and approve. The
      // panel calls POST /api/transactions on Approve — that's the
      // ONLY path that writes a GL row from this flow.
      const today = new Date().toISOString().slice(0, 10);
      const proposal = {
        vendor: String(args.vendor || "").trim(),
        amount:
          args.amount == null
            ? null
            : Math.abs(Math.round(Number(args.amount) * 100) / 100),
        date: args.date || today,
        category: args.category || "",
        payment_source: args.payment_source || "",
        reference_kind: args.reference_kind || "",
        reference_number: args.reference_number || "",
        description: args.description || "",
        notes: args.notes || "",
        currency: "USD",
      };
      const title =
        proposal.amount != null && proposal.vendor
          ? `Draft transaction · ${proposal.vendor} · $${proposal.amount.toFixed(2)}`
          : "Draft transaction";
      return {
        __panel: {
          kind: "transaction_draft",
          title,
          props: { proposal },
        },
        // Echo what the agent proposed back into its own context so it
        // can refer to the draft in follow-up turns ("approve it",
        // "change the date to ...") if useful.
        proposal,
      };
    }

    case "show_transaction_table": {
      const rows = await listTransactions({
        from: args.from,
        to: args.to,
        category: args.category,
        payment_source: args.payment_source,
      });
      let filtered = rows;
      if (args.vendor)
        filtered = filtered.filter((r) => vendorMatches(r.vendor, args.vendor));
      const truncated = filtered.length > TXN_TABLE_LIMIT;
      const view = filtered.slice(0, TXN_TABLE_LIMIT).map(scrubTransaction);
      const filterDesc = describeFilters(args);
      const title =
        args.title ??
        (filterDesc ? `Transactions · ${filterDesc}` : "Transactions");
      const total_amount = filtered.reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0,
      );
      return {
        __panel: {
          kind: "transaction_table",
          title,
          props: {
            filters: {
              from: args.from ?? null,
              to: args.to ?? null,
              category: args.category ?? null,
              payment_source: args.payment_source ?? null,
              vendor: args.vendor ?? null,
            },
            count: filtered.length,
            shown: view.length,
            truncated,
            total_amount: Math.round(total_amount * 100) / 100,
            transactions: view,
          },
        },
        count: filtered.length,
        shown: view.length,
        truncated,
        total_amount: Math.round(total_amount * 100) / 100,
      };
    }

    case "show_awaiting_table": {
      let rows = await listAwaiting({ status: "awaiting" });
      if (args.vendor)
        rows = rows.filter((r) => vendorMatches(r.vendor, args.vendor));
      const today = new Date().toISOString().slice(0, 10);
      const entries = rows.map((r) => {
        const scrubbed = scrubAwaiting(r);
        return {
          ...scrubbed,
          days_outstanding:
            scrubbed.date ? Math.max(0, daysBetween(scrubbed.date, today)) : null,
        };
      });
      entries.sort((a, b) => (b.days_outstanding ?? 0) - (a.days_outstanding ?? 0));
      const total_outstanding = entries.reduce(
        (sum, r) => sum + (Number(r.amount) || 0),
        0,
      );
      const title =
        args.title ??
        (args.vendor ? `Outstanding · ${args.vendor}` : "Outstanding invoices");
      return {
        __panel: {
          kind: "awaiting_table",
          title,
          props: {
            count: entries.length,
            total_outstanding: Math.round(total_outstanding * 100) / 100,
            entries,
          },
        },
        count: entries.length,
        total_outstanding: Math.round(total_outstanding * 100) / 100,
        entries: entries.slice(0, 50).map((e) => ({
          id: e.id,
          vendor: e.vendor,
          date: e.date,
          amount: e.amount,
          currency: e.currency,
          reference_number: e.reference_number,
          days_outstanding: e.days_outstanding,
        })),
      };
    }

    case "show_vendor_timeline": {
      if (!args.vendor) {
        throw new Error("show_vendor_timeline requires 'vendor'");
      }
      const props = await buildTimelineProps({
        vendor: args.vendor,
        from: args.from,
        to: args.to,
      });
      const title = args.title ?? `Timeline · ${props.vendor}`;
      return {
        __panel: { kind: "vendor_timeline", title, props },
        vendor: props.vendor,
        invoice_count: props.summary.invoice_count,
        payment_count: props.summary.payment_count,
        outstanding_balance: props.summary.outstanding_balance,
        overdue_count: props.summary.overdue_count,
      };
    }

    case "show_main_timeline": {
      const props = await buildTimelineProps({
        vendor: null,
        from: args.from,
        to: args.to,
      });
      const title = args.title ?? "All activity";
      return {
        __panel: { kind: "vendor_timeline", title, props },
        invoice_count: props.summary.invoice_count,
        payment_count: props.summary.payment_count,
        distinct_vendors: props.summary.distinct_vendors,
        outstanding_balance: props.summary.outstanding_balance,
        overdue_count: props.summary.overdue_count,
      };
    }

    case "show_category_timeline": {
      if (!args.category) {
        throw new Error("show_category_timeline requires 'category'");
      }
      const props = await buildTimelineProps({
        category: args.category,
        from: args.from,
        to: args.to,
      });
      const title =
        args.title ?? `Category · ${props.category ?? args.category}`;
      return {
        __panel: { kind: "vendor_timeline", title, props },
        category: props.category,
        payment_count: props.summary.payment_count,
        deposit_count: props.summary.deposit_count,
        distinct_vendors: props.summary.distinct_vendors,
        total_paid: props.summary.total_paid,
      };
    }

    case "show_category_manager": {
      return {
        __panel: {
          kind: "category_manager",
          title: args.title ?? "Manage categories",
          props: {},
        },
      };
    }

    case "add_category": {
      if (!args.name) throw new Error("add_category requires 'name'");
      const result = await addCategory({
        name: args.name,
        type: args.type ?? "expense",
        description: args.description ?? "",
      });
      return result; // { added, name }
    }

    case "update_category": {
      if (!args.name) throw new Error("update_category requires 'name'");
      const result = await updateCategory(args.name, {
        name: args.new_name,
        type: args.type,
        description: args.description,
        active: args.active,
      });
      return result; // { name, old_name, renamed, recategorized, active }
    }

    case "show_file_list": {
      const kindFilter = args.kind ?? "all";
      const hasNarrowingFilter = Boolean(
        args.vendor || args.from || args.to,
      );
      // Include the ledger workbook only when the user is asking broadly
      // (kind='all' with no vendor/date narrowing) or explicitly for the
      // ledger. Asking for 'Anthropic files' or 'all receipt files' should
      // not surface the workbook — it's a system file, not a vendor doc.
      const wantLedger =
        kindFilter === "ledger" ||
        (kindFilter === "all" && !hasNarrowingFilter);
      const wantDocuments = kindFilter !== "ledger";

      const files = [];

      // Pin the ledger workbook at the top when included.
      if (wantLedger) {
        const ledgerPath = getLedgerPath();
        files.push({
          id: "ledger",
          kind: "ledger",
          vendor: null,
          date: null,
          reference_number: null,
          filename: path.basename(ledgerPath),
          download_path: "/api/files/ledger",
          download_filename: path.basename(ledgerPath),
          txn_id: null,
        });
      }

      if (wantDocuments) {
        let docs = await listDocuments();
        if (kindFilter !== "all") {
          docs = docs.filter((d) => d.reference_kind === kindFilter);
        }
        if (args.vendor) {
          docs = docs.filter((d) => vendorMatches(d.vendor, args.vendor));
        }
        if (args.from) {
          docs = docs.filter(
            (d) => d.date && new Date(d.date) >= new Date(args.from),
          );
        }
        if (args.to) {
          docs = docs.filter(
            (d) => d.date && new Date(d.date) <= new Date(args.to),
          );
        }
        docs.sort((a, b) => {
          const ad = isoDate(a.date) ?? "";
          const bd = isoDate(b.date) ?? "";
          return bd.localeCompare(ad);
        });
        const HARD_CAP = 100;
        const requested = Math.min(
          Number.isInteger(args.limit) && args.limit > 0
            ? args.limit
            : HARD_CAP,
          HARD_CAP,
        );
        const truncated = docs.length > requested;
        docs = docs.slice(0, requested);
        for (const d of docs) {
          files.push({
            id: d.id,
            kind: d.reference_kind ?? "other",
            vendor: d.vendor,
            date: isoDate(d.date),
            reference_number: d.reference_number ?? null,
            filename: d.filename,
            download_path: `/api/documents/by-id/${encodeURIComponent(d.id)}`,
            download_filename: d.original_filename || d.filename,
            txn_id: d.txn_id ?? null,
            _truncated_hint: truncated, // for summary; per-row no-op
          });
        }
      }

      const docFiles = files.filter((f) => f.kind !== "ledger");
      const docTruncated = docFiles.some((f) => f._truncated_hint);
      for (const f of files) delete f._truncated_hint;
      const counts = files.reduce((acc, f) => {
        acc[f.kind] = (acc[f.kind] ?? 0) + 1;
        return acc;
      }, {});

      const filterParts = [];
      if (kindFilter !== "all") filterParts.push(`kind=${kindFilter}`);
      if (args.vendor) filterParts.push(`vendor=${args.vendor}`);
      if (args.from && args.to)
        filterParts.push(`${args.from} – ${args.to}`);
      else if (args.from) filterParts.push(`from ${args.from}`);
      else if (args.to) filterParts.push(`through ${args.to}`);
      const filterDesc = filterParts.join(" · ");
      const title =
        args.title ??
        (filterDesc ? `Files · ${filterDesc}` : "Files");

      return {
        __panel: {
          kind: "file_list",
          title,
          props: {
            kind_filter: kindFilter,
            count: files.length,
            truncated: docTruncated,
            counts,
            files,
          },
        },
        count: files.length,
        truncated: docTruncated,
        counts,
        files: files.slice(0, 50).map((f) => ({
          id: f.id,
          kind: f.kind,
          vendor: f.vendor,
          date: f.date,
          reference_number: f.reference_number,
          filename: f.filename,
          txn_id: f.txn_id,
        })),
      };
    }

    case "read_statement": {
      if (!args.statement_id) {
        throw new Error("read_statement requires statement_id");
      }
      const stmt = await getStatement(args.statement_id);
      if (!stmt) {
        return {
          loaded: false,
          reason: "statement_not_found",
          statement_id: args.statement_id,
        };
      }
      if (!stmt.document_path) {
        return {
          loaded: false,
          reason: "no_archived_document",
          statement_id: args.statement_id,
        };
      }
      const absolute = resolveStatementPath({
        companyId: AGENT_COMPANY_ID,
        documentPath: stmt.document_path,
      });
      if (!absolute) {
        return {
          loaded: false,
          reason: "invalid_document_path",
          statement_id: args.statement_id,
        };
      }
      let buffer;
      try {
        buffer = await fs.readFile(absolute);
      } catch (err) {
        return {
          loaded: false,
          reason: "read_failed",
          error: err.message,
          statement_id: args.statement_id,
        };
      }
      const ext = path.extname(absolute).slice(1).toLowerCase();
      // Statements are PDFs in practice (the upload path enforces this).
      // Be defensive in case future uploads accept image formats too.
      let mime;
      if (ext === "pdf") mime = "application/pdf";
      else if (ext === "png") mime = "image/png";
      else if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
      else if (ext === "webp") mime = "image/webp";
      else {
        return {
          loaded: false,
          reason: "unsupported_extension",
          extension: ext,
          statement_id: args.statement_id,
        };
      }
      const base64 = buffer.toString("base64");
      const contentBlock = mime.startsWith("image/")
        ? {
            type: "image",
            source: { type: "base64", media_type: mime, data: base64 },
          }
        : {
            type: "document",
            source: { type: "base64", media_type: mime, data: base64 },
            title: `Statement · ${stmt.source ?? "(unknown source)"}`,
          };

      const periodText =
        isoDate(stmt.period_start) && isoDate(stmt.period_end)
          ? `${isoDate(stmt.period_start)} → ${isoDate(stmt.period_end)}`
          : "(period unknown)";
      const balancesText = [
        stmt.opening_balance != null
          ? `opening ${stmt.opening_balance}`
          : null,
        stmt.closing_balance != null
          ? `closing ${stmt.closing_balance}`
          : null,
      ]
        .filter(Boolean)
        .join(", ");

      return {
        __tool_content: [
          contentBlock,
          {
            type: "text",
            text:
              `Statement document loaded (${path.basename(absolute)}, ${buffer.byteLength} bytes).\n` +
              `Source: ${stmt.source ?? "(unknown)"}\n` +
              `Period: ${periodText}\n` +
              `Statement date: ${isoDate(stmt.statement_date) ?? "(unknown)"}\n` +
              (balancesText ? `Balances: ${balancesText}\n` : "") +
              `Parsed lines on file: ${stmt.transaction_count ?? "(unknown)"}.\n\n` +
              `You can now answer questions about the document's actual contents — line items, fees, vendor names, footnotes, balance roll-forwards, etc. Cite specifics; don't paraphrase the document verbatim when summarizing.`,
          },
        ],
        loaded: true,
        statement_id: args.statement_id,
        source: stmt.source,
        period: { from: isoDate(stmt.period_start), to: isoDate(stmt.period_end) },
        bytes: buffer.byteLength,
        filename: path.basename(absolute),
      };
    }

    case "show_reconciliation": {
      // Resolve the statement: explicit id wins; otherwise pick by source
      // hint; otherwise just the most recent statement on file.
      let statementId = args.statement_id ?? null;
      if (!statementId) {
        const candidate = await findStatementBySource(args.source ?? null);
        statementId = candidate?.id ?? null;
      }
      if (!statementId) {
        return {
          __panel: {
            kind: "reconciliation",
            title: "Reconciliation",
            props: {
              error: "No statement found to reconcile. Upload a bank or card statement first.",
              statement: null,
              counts: null,
              matched: [],
              unmatched_debits: [],
              unmatched_credits: [],
              unreconciled_gl: [],
              source_diagnostic: null,
            },
          },
          matched: 0,
        };
      }

      // Run auto-match first (idempotent — no-ops if nothing matchable),
      // then build the view from the freshly-persisted state.
      const matchResult = await autoMatchStatement(statementId);
      const view = await buildReconciliationView(statementId);

      return {
        __panel: {
          kind: "reconciliation",
          title: view?.statement?.source
            ? `Reconciliation · ${view.statement.source}`
            : "Reconciliation",
          props: view,
        },
        statement_id: statementId,
        auto_matched_now: matchResult.matched,
        attempted: matchResult.attempted,
        counts: view?.counts ?? null,
      };
    }

    case "show_statements_list": {
      const status = args.status ?? "all";
      let rows = await listStatements({ status });
      if (args.source) rows = rows.filter((r) => r.source === args.source);

      // Pull line counts in one pass so the panel can show them per row
      // without N round trips to the lines sheet.
      const allLines = await listStatementLines();
      const linesByStatement = new Map();
      for (const ln of allLines) {
        const k = ln.statement_id;
        linesByStatement.set(k, (linesByStatement.get(k) ?? 0) + 1);
      }

      const entries = rows
        .map((r) => ({
          id: r.id,
          status: r.status,
          source: r.source,
          period_start: isoDate(r.period_start),
          period_end: isoDate(r.period_end),
          statement_date: isoDate(r.statement_date),
          currency: r.currency ?? "USD",
          opening_balance: r.opening_balance ?? null,
          closing_balance: r.closing_balance ?? null,
          total_charges: r.total_charges ?? null,
          total_payments: r.total_payments ?? null,
          line_count: linesByStatement.get(r.id) ?? 0,
          document_path: r.document_path ?? null,
          download_path: r.document_path
            ? `/api/documents/statement/${encodeURIComponent(r.id)}`
            : null,
          original_filename: r.original_filename ?? null,
          notes: r.notes ?? "",
        }))
        .sort((a, b) =>
          (b.statement_date ?? "").localeCompare(a.statement_date ?? ""),
        );

      const counts = entries.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});

      const filterParts = [];
      if (status !== "all") filterParts.push(`status=${status}`);
      if (args.source) filterParts.push(`source=${args.source}`);
      const filterDesc = filterParts.join(" · ");
      const title =
        args.title ??
        (filterDesc ? `Statements · ${filterDesc}` : "Statements");

      // Slim per-statement summary returned to the AGENT (NOT the panel,
      // which already has the full entries). Without this the agent can
      // see how many statements exist but not their ids, so follow-up
      // calls like read_statement / show_reconciliation have nothing to
      // reference. Keep this trim — id + the fields the agent needs to
      // disambiguate the user's reference.
      const agentEntries = entries.slice(0, 50).map((e) => ({
        id: e.id,
        source: e.source,
        statement_date: e.statement_date,
        period_start: e.period_start,
        period_end: e.period_end,
        status: e.status,
        line_count: e.line_count,
      }));

      return {
        __panel: {
          kind: "statements_list",
          title,
          props: {
            status_filter: status,
            count: entries.length,
            counts,
            entries,
          },
        },
        count: entries.length,
        counts,
        entries: agentEntries,
      };
    }

    case "show_deposit_activity": {
      // Produce data in the same shape as buildTimelineProps so the
      // existing VendorTimelinePanel can render it. Right side gets
      // ONLY income-typed GL rows ("deposit" cards, green styling).
      // Left side is empty — deposits don't have vendor-issued
      // artifacts like invoices/receipts. Totals stripe still shows
      // "Payments out: $0 · Deposits in: $X" since the panel was
      // built for that two-stripe display.
      const today2 = new Date();
      const defaultTo2 = today2.toISOString().slice(0, 10);
      const past2 = new Date(
        Date.UTC(today2.getUTCFullYear(), today2.getUTCMonth() - 11, 1),
      );
      const defaultFrom2 = past2.toISOString().slice(0, 10);
      const from = args.from || defaultFrom2;
      const to = args.to || defaultTo2;

      let txns = await listTransactions({ from, to });
      // Income only.
      txns = txns.filter((r) => r.entry_type === "income");
      if (args.vendor) {
        txns = txns.filter((t) => vendorMatches(t.vendor, args.vendor));
      }
      if (args.category) {
        txns = txns.filter((t) => t.category === args.category);
      }

      const rightEvents = txns.map((r) => ({
        id: r.id,
        kind: "deposit",
        entry_type: "income",
        date: isoDate(r.date),
        amount: Math.round(Math.abs(Number(r.amount) || 0) * 100) / 100,
        currency: r.currency ?? "USD",
        reference_number: r.reference_number ?? null,
        reference_kind: r.reference_kind ?? null,
        description: r.description ?? "",
        category: r.category ?? null,
        payment_source: r.payment_source ?? null,
        vendor: r.vendor,
        link_id: r.id,
        statement_matched: false,
      }));

      // Same date-row builder as buildTimelineProps: group events by
      // ISO date so VendorTimelinePanel's existing layout works.
      const dateSet = new Set(
        rightEvents.map((e) => e.date).filter(Boolean),
      );
      const sortedDates = [...dateSet].sort().reverse();
      const rows = sortedDates.map((d) => ({
        date: d,
        left: [],
        right: rightEvents.filter((e) => e.date === d),
      }));

      const totalDeposits = rightEvents.reduce(
        (s, e) => s + (e.amount ?? 0),
        0,
      );
      const distinctSources = new Set(rightEvents.map((e) => e.vendor)).size;

      const filterParts = [];
      if (args.vendor) filterParts.push(`vendor=${args.vendor}`);
      if (args.category) filterParts.push(`category=${args.category}`);
      if (args.from) filterParts.push(`from ${args.from}`);
      if (args.to) filterParts.push(`through ${args.to}`);
      const filterDesc = filterParts.join(" · ");
      const title =
        args.title ??
        (filterDesc ? `Deposit activity · ${filterDesc}` : "Deposit activity");

      const agentEntries = rightEvents
        .slice(0, 50)
        .map((e) => ({
          id: e.id,
          date: e.date,
          vendor: e.vendor,
          amount: e.amount,
          category: e.category,
          payment_source: e.payment_source,
        }));

      const today3 = new Date().toISOString().slice(0, 10);

      return {
        __panel: {
          kind: "deposit_activity",
          title,
          props: {
            vendor: "Deposit activity",
            query: null,
            is_global: true,
            period: { from, to },
            rows,
            summary: {
              // total_paid stays at zero on this filtered view; the
              // panel's "Payments out" stripe renders $0 explicitly
              // rather than getting hidden, since seeing both stripes
              // keeps the income vs expense framing intact.
              total_invoiced: 0,
              total_paid: 0,
              total_deposits: Math.round(totalDeposits * 100) / 100,
              total_left: 0,
              total_right: Math.round(totalDeposits * 100) / 100,
              outstanding_balance: 0,
              invoice_count: 0,
              payment_count: 0,
              deposit_count: rightEvents.length,
              awaiting_count: 0,
              overdue_count: 0,
              distinct_vendors: distinctSources,
              outstanding_invoices: [],
              overdue_days_threshold: TIMELINE_OVERDUE_DAYS,
              as_of: today3,
            },
          },
        },
        count: rightEvents.length,
        total_deposits: Math.round(totalDeposits * 100) / 100,
        entries: agentEntries,
      };
    }

    case "show_statement_timeline": {
      // Produce data in the SAME shape as buildTimelineProps so the
      // existing VendorTimelinePanel can render it. The only thing that
      // differs is the event population:
      //   - Left side: card-balance awaiting-transfer rows (the
      //     `is_transfer_obligation: true` rows we auto-create at
      //     card-statement import — they render as "Card balance".
      //   - Right side: bank statements as new "Statement" cards.
      // Everything else (regular invoices/receipts/payments/GL transfers)
      // is excluded — this is a statements-only view.
      const sourceKindFilter = args.source_kind ?? "all";
      let allStatements = await listStatements({ status: "all" });

      // source_kind backfill (legacy rows imported before the parser
      // populated the field).
      const sources = await getPaymentSources({ activeOnly: false });
      const last4 = (s) => {
        if (!s) return null;
        const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
        return m ? m[1] : null;
      };
      // Only treat explicit "credit_card" / "bank_account" from the
      // Sources sheet as authoritative. "other" and "cash" don't help
      // us decide which timeline side to use (and "other" is the
      // ensurePaymentSource default for sources that aren't tagged
      // yet) — fall through to the name heuristic in those cases.
      const SPECIFIC_KINDS = new Set(["credit_card", "bank_account"]);
      function resolveSourceKind(stmt) {
        if (SPECIFIC_KINDS.has(stmt.source_kind)) return stmt.source_kind;
        const exact = sources.find((s) => s.name === stmt.source);
        if (exact?.type && SPECIFIC_KINDS.has(exact.type)) return exact.type;
        const stmtLast4 = last4(stmt.source);
        if (stmtLast4) {
          const byLast4 = sources.find(
            (s) => last4(s.name) === stmtLast4 && SPECIFIC_KINDS.has(s.type),
          );
          if (byLast4?.type) return byLast4.type;
        }
        // Name heuristic — banks announce themselves clearly; otherwise
        // anything with a last-4 marker or card-issuer keyword is a card.
        const lower = String(stmt.source || "").toLowerCase();
        if (/\b(banking|bank account|checking|savings)\b/.test(lower)) {
          return "bank_account";
        }
        if (
          /\b(card|visa|mastercard|amex|american express|discover|credit|cash rewards)\b/.test(
            lower,
          ) ||
          stmtLast4
        ) {
          return "credit_card";
        }
        return null;
      }
      allStatements = allStatements.map((r) => ({
        ...r,
        source_kind: resolveSourceKind(r),
      }));

      // Apply user-supplied filters.
      let statements = allStatements;
      if (sourceKindFilter !== "all") {
        statements = statements.filter(
          (r) => r.source_kind === sourceKindFilter,
        );
      }
      if (args.source) {
        statements = statements.filter((r) => r.source === args.source);
      }
      if (args.from) {
        statements = statements.filter((r) => {
          const d = isoDate(r.statement_date);
          return d && d >= args.from;
        });
      }
      if (args.to) {
        statements = statements.filter((r) => {
          const d = isoDate(r.statement_date);
          return d && d <= args.to;
        });
      }

      const cardStmts = statements.filter(
        (s) => s.source_kind === "credit_card",
      );
      const bankStmts = statements.filter(
        (s) => s.source_kind === "bank_account",
      );

      // Index awaiting-transfer rows by their originating statement so
      // the card-balance left card lines up with each card statement.
      const allAwaiting = await listAwaiting({ status: "all" });
      const awaitingByStmtId = new Map();
      for (const aw of allAwaiting) {
        if (aw.statement_id) awaitingByStmtId.set(aw.statement_id, aw);
      }

      // Statement-line matched sets for the green check signal.
      const allLines = await listStatementLines();
      const txnIdsMatchedOnStatement = new Set(
        allLines.filter((l) => l.matched_txn_id).map((l) => l.matched_txn_id),
      );
      const transferIdsMatchedOnStatement = new Set(
        allLines
          .filter((l) => l.matched_transfer_id)
          .map((l) => l.matched_transfer_id),
      );

      // Multi-transfer linkage (sum-match settled awaitings).
      const allTransfers = await listTransfers();
      const transfersByAwaiting = new Map();
      for (const t of allTransfers) {
        if (!t.awaiting_id) continue;
        if (!transfersByAwaiting.has(t.awaiting_id)) {
          transfersByAwaiting.set(t.awaiting_id, []);
        }
        transfersByAwaiting.get(t.awaiting_id).push(t);
      }

      // ── Left events: card-balance awaiting-transfer rows ──────────────
      const leftEvents = [];
      for (const stmt of cardStmts) {
        const aw = awaitingByStmtId.get(stmt.id);
        if (!aw) continue;
        const date =
          isoDate(aw.date) ||
          isoDate(stmt.statement_date) ||
          isoDate(stmt.period_end);
        const linkedTransfers = transfersByAwaiting.get(aw.id) ?? [];
        const awStatementMatched =
          (aw.paid_txn_id && txnIdsMatchedOnStatement.has(aw.paid_txn_id)) ||
          (aw.paid_transfer_id &&
            transferIdsMatchedOnStatement.has(aw.paid_transfer_id)) ||
          linkedTransfers.some((t) =>
            transferIdsMatchedOnStatement.has(t.id),
          );
        leftEvents.push({
          id: aw.id,
          kind: aw.reference_kind || "statement",
          payment_kind: "transfer",
          is_transfer_obligation: true,
          date,
          amount: Math.round(Number(aw.amount) * 100) / 100,
          currency: aw.currency ?? "USD",
          reference_number: aw.reference_number ?? null,
          status: aw.status,
          days_outstanding: null,
          paid_at: aw.paid_at
            ? typeof aw.paid_at === "string"
              ? aw.paid_at.slice(0, 10)
              : new Date(aw.paid_at).toISOString().slice(0, 10)
            : null,
          paid_txn_id: aw.paid_txn_id ?? null,
          paid_transfer_id: aw.paid_transfer_id ?? null,
          link_id: aw.paid_transfer_id ?? aw.paid_txn_id ?? aw.id,
          description: aw.description ?? "",
          vendor: aw.vendor,
          source: "awaiting",
          statement_matched: !!awStatementMatched,
        });
      }

      // ── Right events: bank statements as "Statement" cards ────────────
      const rightEvents = [];
      for (const stmt of bankStmts) {
        const date =
          isoDate(stmt.statement_date) || isoDate(stmt.period_end);
        if (!date) continue;
        rightEvents.push({
          id: stmt.id,
          kind: "statement",
          date,
          amount:
            stmt.closing_balance == null
              ? 0
              : Math.round(Math.abs(Number(stmt.closing_balance)) * 100) / 100,
          currency: stmt.currency ?? "USD",
          reference_number: stmt.original_filename || stmt.id,
          reference_kind: "statement",
          description: `${isoDate(stmt.period_start) ?? "?"} → ${isoDate(stmt.period_end) ?? "?"}`,
          category: null,
          payment_source: stmt.source,
          vendor: stmt.source,
          link_id: stmt.id,
          statement_matched: stmt.status === "reconciled",
        });
      }

      // Build rows by date (newest-first), same as buildTimelineProps.
      const dateSet = new Set([
        ...leftEvents.map((e) => e.date).filter(Boolean),
        ...rightEvents.map((e) => e.date).filter(Boolean),
      ]);
      const sortedDates = [...dateSet].sort().reverse();
      const rows = sortedDates.map((d) => ({
        date: d,
        left: leftEvents.filter((e) => e.date === d),
        right: rightEvents.filter((e) => e.date === d),
      }));

      const today = new Date().toISOString().slice(0, 10);
      const totalLeft = leftEvents.reduce((s, e) => s + (e.amount ?? 0), 0);
      const totalRight = rightEvents.reduce((s, e) => s + (e.amount ?? 0), 0);
      const outstandingAmount = leftEvents
        .filter((e) => e.status === "awaiting" || e.status === "overdue")
        .reduce((s, e) => s + (e.amount ?? 0), 0);
      const distinctSources = new Set(
        [...leftEvents, ...rightEvents].map((e) => e.vendor),
      ).size;

      const filterParts = [];
      if (sourceKindFilter !== "all")
        filterParts.push(`kind=${sourceKindFilter}`);
      if (args.source) filterParts.push(`source=${args.source}`);
      if (args.from) filterParts.push(`from ${args.from}`);
      if (args.to) filterParts.push(`through ${args.to}`);
      const filterDesc = filterParts.join(" · ");
      const title =
        args.title ??
        (filterDesc
          ? `Statement activity · ${filterDesc}`
          : "Statement activity");

      // Slim per-statement summary for the agent.
      const agentEntries = statements
        .slice()
        .sort((a, b) =>
          (isoDate(b.statement_date) ?? "").localeCompare(
            isoDate(a.statement_date) ?? "",
          ),
        )
        .slice(0, 50)
        .map((e) => ({
          id: e.id,
          source: e.source,
          source_kind: e.source_kind,
          statement_date: isoDate(e.statement_date),
          period_start: isoDate(e.period_start),
          period_end: isoDate(e.period_end),
          status: e.status,
          closing_balance: e.closing_balance,
        }));

      return {
        __panel: {
          kind: "statement_timeline",
          title,
          props: {
            // Same shape as buildTimelineProps so VendorTimelinePanel
            // can render this view unchanged.
            vendor: "Statement activity",
            query: null,
            is_global: true,
            period: { from: args.from ?? null, to: args.to ?? null },
            rows,
            summary: {
              total_invoiced: Math.round(totalLeft * 100) / 100,
              total_paid: Math.round(totalRight * 100) / 100,
              total_left: Math.round(totalLeft * 100) / 100,
              total_right: Math.round(totalRight * 100) / 100,
              outstanding_balance: Math.round(outstandingAmount * 100) / 100,
              invoice_count: leftEvents.length,
              payment_count: rightEvents.length,
              awaiting_count: leftEvents.filter(
                (e) => e.status === "awaiting",
              ).length,
              overdue_count: leftEvents.filter((e) => e.status === "overdue")
                .length,
              distinct_vendors: distinctSources,
              outstanding_invoices: [],
              overdue_days_threshold: TIMELINE_OVERDUE_DAYS,
              as_of: today,
              transfer_obligation_count: leftEvents.length,
              transfer_count: 0,
              // The Invoices&Receipts / Payments framing doesn't apply
              // to this view (card balances aren't vendor invoices and
              // bank statements aren't payments) — tell the panel to
              // skip the side-totals row above the timeline.
              hide_side_totals: true,
            },
          },
        },
        count: statements.length,
        entries: agentEntries,
      };
    }

    case "show_inbox_list": {
      const status = args.status ?? "all";
      const rows = await listPending({ status });
      // Decorate with source kind (email vs upload) inferred from source_file
      // naming. Sort newest-first by received_at.
      const enriched = rows
        .map((r) => {
          const sf = r.source_file ?? "";
          const source_kind = sf.startsWith("upload-")
            ? "upload"
            : sf.startsWith("inbound-")
              ? "email"
              : "other";
          return {
            id: r.id,
            status: r.status,
            received_at: r.received_at
              ? (typeof r.received_at === "string"
                  ? r.received_at
                  : new Date(r.received_at).toISOString())
              : null,
            vendor: r.vendor,
            date: isoDate(r.date),
            total: r.total,
            currency: r.currency ?? "USD",
            reference_number: r.reference_number ?? null,
            reference_kind: r.reference_kind ?? null,
            suggested_category: r.suggested_category ?? null,
            confidence: r.confidence ?? null,
            resolution_notes: r.resolution_notes ?? null,
            source_kind,
          };
        })
        .sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
      const HARD_CAP = 100;
      const requested = Math.min(
        Number.isInteger(args.limit) && args.limit > 0 ? args.limit : HARD_CAP,
        HARD_CAP,
      );
      const truncated = enriched.length > requested;
      const view = enriched.slice(0, requested);
      const counts = enriched.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        },
        { pending: 0, approved: 0, rejected: 0 },
      );
      const title =
        args.title ??
        (status === "all" ? "Inbox · all items" : `Inbox · ${status}`);
      // Slim entries so the agent can reference specific pending rows by id.
      const agentEntries = view.slice(0, 50).map((r) => ({
        id: r.id,
        status: r.status,
        vendor: r.vendor,
        date: r.date,
        total: r.total,
        currency: r.currency,
        reference_number: r.reference_number,
        suggested_category: r.suggested_category,
        source_kind: r.source_kind,
      }));
      return {
        __panel: {
          kind: "inbox_list",
          title,
          props: {
            status_filter: status,
            count: enriched.length,
            shown: view.length,
            truncated,
            counts,
            entries: view,
          },
        },
        count: enriched.length,
        shown: view.length,
        truncated,
        counts,
        entries: agentEntries,
      };
    }

    case "show_vendor_breakdown": {
      const rows = await listTransactions({
        from: args.from,
        to: args.to,
        category: args.category,
      });
      const buckets = new Map();
      let totalExpense = 0;
      for (const r of rows) {
        const vendor = r.vendor || "(no vendor)";
        const amount = Number(r.amount) || 0;
        totalExpense += amount;
        const b = buckets.get(vendor) ?? { vendor, total: 0, count: 0 };
        b.total += amount;
        b.count += 1;
        buckets.set(vendor, b);
      }
      let vendors = [...buckets.values()]
        .map((b) => ({ ...b, total: Math.round(b.total * 100) / 100 }))
        .sort((a, b) => b.total - a.total);
      const HARD_CAP = 50;
      const requested = Math.min(
        Number.isInteger(args.limit) && args.limit > 0 ? args.limit : HARD_CAP,
        HARD_CAP,
      );
      const truncated = vendors.length > requested;
      vendors = vendors.slice(0, requested);
      const periodDesc =
        args.from && args.to
          ? `${args.from} – ${args.to}`
          : args.from
            ? `from ${args.from}`
            : args.to
              ? `through ${args.to}`
              : "all time";
      const title =
        args.title ??
        (args.category
          ? `Vendors · ${args.category} · ${periodDesc}`
          : `Vendors · ${periodDesc}`);
      const props = {
        period: { from: args.from ?? null, to: args.to ?? null },
        category: args.category ?? null,
        count: vendors.length,
        total_count: rows.length,
        total_expense: Math.round(totalExpense * 100) / 100,
        truncated,
        vendors,
      };
      return {
        __panel: { kind: "vendor_breakdown", title, props },
        count: vendors.length,
        total_count: rows.length,
        total_expense: props.total_expense,
        truncated,
        top_vendor: vendors[0]?.vendor ?? null,
        // Full vendor breakdown for agent reasoning — small payload
        // even for large vendor counts (vendor + total + count only).
        vendors: vendors.slice(0, 50).map((v) => ({
          vendor: v.vendor,
          total: v.total,
          count: v.count,
        })),
      };
    }

    case "show_kpi_summary": {
      const today = new Date();
      const ymdToday = today.toISOString().slice(0, 10);
      const yearStart = `${today.getUTCFullYear()}-01-01`;
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const [pending, ytdTxns, awaiting, recentTxns] = await Promise.all([
        listPending({ status: "pending" }),
        listTransactions({ from: yearStart, to: ymdToday }),
        listAwaiting({ status: "awaiting" }),
        listTransactions({ from: thirtyDaysAgo, to: ymdToday }),
      ]);

      const ytdSpend = ytdTxns.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0,
      );
      const outstanding = awaiting.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0,
      );
      const recent30dSpend = recentTxns.reduce(
        (s, r) => s + (Number(r.amount) || 0),
        0,
      );

      const props = {
        as_of: ymdToday,
        pending_count: pending.length,
        ytd_spend: Math.round(ytdSpend * 100) / 100,
        ytd_count: ytdTxns.length,
        outstanding_total: Math.round(outstanding * 100) / 100,
        outstanding_count: awaiting.length,
        recent_30d_spend: Math.round(recent30dSpend * 100) / 100,
        recent_30d_count: recentTxns.length,
      };
      return {
        __panel: {
          kind: "kpi_summary",
          title: args.title ?? `State of the books · ${ymdToday}`,
          props,
        },
        ...props,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
