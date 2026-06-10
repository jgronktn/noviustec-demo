// Statement reconciliation — match StatementLines against GL transactions.
//
// Slice 1 scope:
//   - autoMatchStatement(statementId): greedy heuristic match for any
//     unmatched negative-amount lines. Persists matches with
//     match_method="auto" to StatementLines.
//   - buildReconciliationView(statementId): everything the dashboard
//     panel needs to render in one payload — matched pairs, unmatched
//     statement lines, GL rows in the source/period that nothing
//     matched, plus diagnostics for the source-name normalization
//     issue (most common reason for empty match results).
//
// Out of scope (deferred):
//   - "Book as a new transaction" from an unmatched line.
//   - Income-side matching for credit lines (deposits).
//   - Split / partial matches (one line ↔ multiple GL rows).

import {
  getStatement,
  listStatements,
  listStatementLines,
  listTransactions,
  listTransfers,
  updateStatementLine,
  updateStatement,
} from "../ledger/index.js";

// ── Match heuristic configuration ────────────────────────────────────
const DATE_WINDOW_DAYS = 5; // ± days each side of line_date
const AMOUNT_TOLERANCE = 0.01; // dollars

function toIsoDate(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Excel numeric serial date (see handlers.js isoDate for context).
  if (typeof v === "number" && Number.isFinite(v) && v > 1) {
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function daysBetween(a, b) {
  const da = new Date(toIsoDate(a));
  const db = new Date(toIsoDate(b));
  return Math.abs(da - db) / (24 * 60 * 60 * 1000);
}

function addDays(iso, n) {
  if (!iso) return null;
  const d = new Date(toIsoDate(iso));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function extractLast4(s) {
  if (!s) return null;
  // Accept "••XXXX", "•XXXX", "**XXXX", "XX-XXXX", etc.
  const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
  return m ? m[1] : null;
}

/**
 * Decide whether a statement's source name and a GL row's payment_source
 * are the same account. Order of strictness:
 *   1. Exact (case-insensitive, whitespace-trimmed)
 *   2. Both have a ••NNNN last-4 marker AND the digits match
 * Anything else: no match — the user gets to see the divergence in the
 * diagnostic block on the panel and normalize via the Edit dialog.
 */
function sourceMatches(stmtSource, glSource) {
  if (!stmtSource || !glSource) return false;
  const a = stmtSource.toLowerCase().trim();
  const b = glSource.toLowerCase().trim();
  if (a === b) return true;
  const la = extractLast4(stmtSource);
  const lb = extractLast4(glSource);
  if (la && lb && la === lb) return true;
  return false;
}

/**
 * Run the greedy auto-match against a statement's unmatched lines.
 * Idempotent — already-matched lines (manual or auto) are left alone.
 * Returns counts + the list of new matches applied.
 */
export async function autoMatchStatement(statementId) {
  const stmt = await getStatement(statementId);
  if (!stmt) throw new Error(`Statement not found: ${statementId}`);

  const allLinesGlobal = await listStatementLines();
  const lines = allLinesGlobal.filter((l) => l.statement_id === statementId);

  // GL rows already paired to some line — across any statement — so we
  // don't double-claim one txn for two lines.
  const txnIdsAlreadyMatched = new Set(
    allLinesGlobal
      .filter((l) => l.matched_txn_id)
      .map((l) => l.matched_txn_id),
  );
  // Transfer rows already paired similarly (debit side OR credit side of
  // a Transfer counts as one usage of that Transfer).
  const transferIdsAlreadyMatched = new Set(
    allLinesGlobal
      .filter((l) => l.matched_transfer_id)
      .map((l) => l.matched_transfer_id),
  );

  // Each line is matchable by GL only if it's a debit (no income side
  // yet). Lines of either sign are matchable by Transfer — credit-side
  // line on a card statement should match a Transfer where to_source =
  // this statement's source.
  const unmatched = lines.filter(
    (l) => !l.matched_txn_id && !l.matched_transfer_id,
  );

  if (unmatched.length === 0) {
    await refreshStatementStatus(statementId, lines);
    return {
      statement_id: statementId,
      matched: 0,
      attempted: 0,
    };
  }

  // Pull GL + Transfers with a generous padding around the period.
  const periodStart = toIsoDate(stmt.period_start);
  const periodEnd = toIsoDate(stmt.period_end);
  const from = periodStart ? addDays(periodStart, -DATE_WINDOW_DAYS) : undefined;
  const to = periodEnd ? addDays(periodEnd, DATE_WINDOW_DAYS) : undefined;
  const [allGl, allTransfers] = await Promise.all([
    listTransactions({ from, to }),
    listTransfers({ from, to }),
  ]);

  const candidateGl = allGl.filter((g) =>
    sourceMatches(stmt.source, g.payment_source),
  );

  const newGlMatches = [];
  const newTransferMatches = [];

  for (const line of unmatched) {
    const lineAmount = Math.abs(Number(line.amount));
    const isDebit = Number(line.amount) < 0;

    // GL match (debits only — no income side yet).
    let bestGl = null;
    if (isDebit) {
      for (const g of candidateGl) {
        if (txnIdsAlreadyMatched.has(g.id)) continue;
        const amountDiff = Math.abs(Number(g.amount) - lineAmount);
        if (amountDiff > AMOUNT_TOLERANCE) continue;
        const daysOff = daysBetween(line.line_date, g.date);
        if (daysOff > DATE_WINDOW_DAYS) continue;
        if (!bestGl || daysOff < bestGl.daysOff) {
          bestGl = { txn: g, daysOff };
        }
      }
    }

    // Transfer match — works on EITHER side. A debit line on this
    // statement should match a Transfer whose FROM source is this
    // statement's source (money left this account). A credit line
    // should match a Transfer whose TO source is this statement's
    // source (money arrived at this account).
    let bestTransfer = null;
    for (const t of allTransfers) {
      if (transferIdsAlreadyMatched.has(t.id)) continue;
      const sideMatches = isDebit
        ? sourceMatches(stmt.source, t.from_source)
        : sourceMatches(stmt.source, t.to_source);
      if (!sideMatches) continue;
      const amountDiff = Math.abs(Number(t.amount) - lineAmount);
      if (amountDiff > AMOUNT_TOLERANCE) continue;
      const daysOff = daysBetween(line.line_date, t.date);
      if (daysOff > DATE_WINDOW_DAYS) continue;
      if (!bestTransfer || daysOff < bestTransfer.daysOff) {
        bestTransfer = { transfer: t, daysOff };
      }
    }

    // Prefer the closer-dated of the two; tie-breaker → GL (more common).
    if (bestGl && bestTransfer) {
      if (bestTransfer.daysOff < bestGl.daysOff) {
        bestGl = null;
      } else {
        bestTransfer = null;
      }
    }

    if (bestGl) {
      newGlMatches.push({
        line_id: line.id,
        txn_id: bestGl.txn.id,
        days_off: bestGl.daysOff,
      });
      txnIdsAlreadyMatched.add(bestGl.txn.id);
    } else if (bestTransfer) {
      newTransferMatches.push({
        line_id: line.id,
        transfer_id: bestTransfer.transfer.id,
        days_off: bestTransfer.daysOff,
      });
      transferIdsAlreadyMatched.add(bestTransfer.transfer.id);
    }
  }

  for (const m of newGlMatches) {
    await updateStatementLine(m.line_id, {
      matched_txn_id: m.txn_id,
      matched_transfer_id: null,
      match_method: "auto",
    });
  }
  for (const m of newTransferMatches) {
    await updateStatementLine(m.line_id, {
      matched_txn_id: null,
      matched_transfer_id: m.transfer_id,
      match_method: "auto",
    });
  }

  // Re-read to reflect persisted state, then update Statement.status.
  const linesAfter = (await listStatementLines()).filter(
    (l) => l.statement_id === statementId,
  );
  await refreshStatementStatus(statementId, linesAfter);

  const totalNew = newGlMatches.length + newTransferMatches.length;
  return {
    statement_id: statementId,
    matched: totalNew,
    matched_gl: newGlMatches.length,
    matched_transfer: newTransferMatches.length,
    attempted: unmatched.length,
    gl_matches: newGlMatches,
    transfer_matches: newTransferMatches,
  };
}

/**
 * Derive + persist the Statement's reconciliation status from its lines.
 * Resolution rules:
 *   - A NEGATIVE-amount line resolves when it has matched_txn_id (booked
 *     as an expense) OR matched_transfer_id (transfer-out).
 *   - A POSITIVE-amount line resolves when it has matched_transfer_id
 *     (transfer-in). Income matching isn't built yet, so a credit with
 *     no transfer is still considered unresolved — but doesn't count
 *     against partial status because we'd never resolve it anyway.
 * Status:
 *   reconciled            — every negative line resolved AND every
 *                           positive line either resolved or income-side
 *                           is N/A (we tolerate unresolved credits for now)
 *   partially_reconciled  — some negatives resolved, not all
 *   imported              — no negatives resolved yet
 */
async function refreshStatementStatus(statementId, lines) {
  const negs = lines.filter((l) => Number(l.amount) < 0);
  const negsResolved = negs.filter(
    (l) => l.matched_txn_id || l.matched_transfer_id,
  ).length;
  let status = "imported";
  if (negs.length > 0 && negsResolved === negs.length) status = "reconciled";
  else if (negsResolved > 0) status = "partially_reconciled";
  // Only write if changed — keep churn low.
  const stmt = await getStatement(statementId);
  if (stmt && stmt.status !== status) {
    await updateStatement(statementId, { status });
  }
  return status;
}

// ── View builder (panel payload) ─────────────────────────────────────

function scrubLine(line) {
  return {
    id: line.id,
    statement_id: line.statement_id,
    line_date: toIsoDate(line.line_date),
    description: line.description ?? "",
    amount:
      line.amount == null
        ? null
        : Math.round(Number(line.amount) * 100) / 100,
    balance_after:
      line.balance_after == null
        ? null
        : Math.round(Number(line.balance_after) * 100) / 100,
    matched_txn_id: line.matched_txn_id ?? null,
    matched_transfer_id: line.matched_transfer_id ?? null,
    match_method: line.match_method ?? null,
    notes: line.notes ?? "",
  };
}

function scrubTransferMinimal(t) {
  return {
    id: t.id,
    date: toIsoDate(t.date),
    amount: t.amount == null ? null : Math.round(Number(t.amount) * 100) / 100,
    currency: t.currency ?? "USD",
    from_source: t.from_source ?? null,
    to_source: t.to_source ?? null,
    description: t.description ?? "",
    awaiting_id: t.awaiting_id ?? null,
  };
}

function scrubGlMinimal(g) {
  return {
    id: g.id,
    date: toIsoDate(g.date),
    vendor: g.vendor ?? null,
    description: g.description ?? "",
    category: g.category ?? null,
    payment_source: g.payment_source ?? null,
    amount: g.amount == null ? null : Math.round(Number(g.amount) * 100) / 100,
    currency: g.currency ?? "USD",
    reference_number: g.reference_number ?? null,
    reference_kind: g.reference_kind ?? null,
  };
}

function scrubStatement(s) {
  return {
    id: s.id,
    status: s.status,
    source: s.source,
    source_kind: s.source_kind ?? null,
    period_start: toIsoDate(s.period_start),
    period_end: toIsoDate(s.period_end),
    statement_date: toIsoDate(s.statement_date),
    currency: s.currency ?? "USD",
    opening_balance: s.opening_balance ?? null,
    closing_balance: s.closing_balance ?? null,
    total_charges: s.total_charges ?? null,
    total_payments: s.total_payments ?? null,
    document_path: s.document_path ?? null,
  };
}

/**
 * Assemble the full reconciliation payload for the panel:
 *   - statement summary (source, period, balances, status)
 *   - counts ({total_lines, matched, unmatched_debit, unmatched_credit,
 *     unreconciled_gl})
 *   - matched pairs (line + the GL row it points at)
 *   - unmatched lines (split into debit and credit for UI clarity)
 *   - unreconciled GL rows in the same source+period not pointed to by
 *     any line on this statement
 *   - source_diagnostic — surfaces the most common foot-gun: GL rows
 *     for this period whose payment_source name doesn't match the
 *     statement's stored source name closely enough to auto-match.
 */
export async function buildReconciliationView(statementId) {
  const stmt = await getStatement(statementId);
  if (!stmt) return null;

  const lines = (await listStatementLines()).filter(
    (l) => l.statement_id === statementId,
  );

  // Look at GL + Transfers for the period, with padding.
  const periodStart = toIsoDate(stmt.period_start);
  const periodEnd = toIsoDate(stmt.period_end);
  const from = periodStart ? addDays(periodStart, -DATE_WINDOW_DAYS) : undefined;
  const to = periodEnd ? addDays(periodEnd, DATE_WINDOW_DAYS) : undefined;
  const [allGl, allTransfers] = await Promise.all([
    listTransactions({ from, to }),
    listTransfers({ from, to }),
  ]);
  const glById = new Map(allGl.map((g) => [g.id, g]));
  const transferById = new Map(allTransfers.map((t) => [t.id, t]));
  const candidateGl = allGl.filter((g) =>
    sourceMatches(stmt.source, g.payment_source),
  );
  const candidateTransfers = allTransfers.filter(
    (t) =>
      sourceMatches(stmt.source, t.from_source) ||
      sourceMatches(stmt.source, t.to_source),
  );

  const matchedTxnIds = new Set(
    lines.filter((l) => l.matched_txn_id).map((l) => l.matched_txn_id),
  );
  const matchedTransferIds = new Set(
    lines.filter((l) => l.matched_transfer_id).map((l) => l.matched_transfer_id),
  );

  const matched = [];
  const unmatchedDebits = [];
  const unmatchedCredits = [];
  for (const line of lines) {
    const scrubbed = scrubLine(line);
    if (line.matched_txn_id) {
      const gl = glById.get(line.matched_txn_id);
      matched.push({
        ...scrubbed,
        match_kind: "txn",
        matched_txn: gl ? scrubGlMinimal(gl) : null,
        matched_transfer: null,
      });
    } else if (line.matched_transfer_id) {
      const t = transferById.get(line.matched_transfer_id);
      matched.push({
        ...scrubbed,
        match_kind: "transfer",
        matched_txn: null,
        matched_transfer: t ? scrubTransferMinimal(t) : null,
      });
    } else if (Number(line.amount) < 0) {
      unmatchedDebits.push(scrubbed);
    } else {
      unmatchedCredits.push(scrubbed);
    }
  }

  const unreconciledGl = candidateGl
    .filter((g) => !matchedTxnIds.has(g.id))
    .map(scrubGlMinimal)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  // Broader picker pool: every unmatched GL row in the period regardless
  // of payment_source. Each tagged with source_matches so the UI can
  // sort/warn appropriately. Needed when a card statement's source name
  // doesn't agree with how the GL rows were tagged (very common before
  // the user has normalized last-4 conventions across imports).
  const allUnreconciledGlInPeriod = allGl
    .filter((g) => !matchedTxnIds.has(g.id))
    .map((g) => ({
      ...scrubGlMinimal(g),
      source_matches: sourceMatches(stmt.source, g.payment_source),
    }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const unreconciledTransfers = candidateTransfers
    .filter((t) => !matchedTransferIds.has(t.id))
    .map(scrubTransferMinimal)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  // Diagnostic: payment_sources we saw on GL rows for this period that
  // weren't matched against the statement source — most common cause of
  // an empty reconciliation result.
  const glSourcesSeen = new Map(); // name → count
  for (const g of allGl) {
    const s = g.payment_source;
    if (!s) continue;
    glSourcesSeen.set(s, (glSourcesSeen.get(s) ?? 0) + 1);
  }

  const sourcesNotMatched = [...glSourcesSeen.entries()]
    .filter(([s]) => !sourceMatches(stmt.source, s))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Payments-vs-transfers diagnostic for credit-card statements: the
  // statement's "Total Payments" should equal the sum of transfer-ins
  // for this card during the period.
  let payments_diagnostic = null;
  if (
    stmt.source_kind === "credit_card" &&
    stmt.total_payments != null
  ) {
    const transfersInAmount = lines
      .filter((l) => Number(l.amount) > 0 && l.matched_transfer_id)
      .reduce((s, l) => s + Math.abs(Number(l.amount)), 0);
    payments_diagnostic = {
      statement_total_payments:
        Math.round(Number(stmt.total_payments) * 100) / 100,
      matched_transfers_in: Math.round(transfersInAmount * 100) / 100,
      diff:
        Math.round((Number(stmt.total_payments) - transfersInAmount) * 100) /
        100,
    };
  }

  return {
    statement: scrubStatement(stmt),
    counts: {
      total_lines: lines.length,
      matched: matched.length,
      unmatched_debit: unmatchedDebits.length,
      unmatched_credit: unmatchedCredits.length,
      unreconciled_gl: unreconciledGl.length,
      unreconciled_transfers: unreconciledTransfers.length,
    },
    matched,
    unmatched_debits: unmatchedDebits,
    unmatched_credits: unmatchedCredits,
    unreconciled_gl: unreconciledGl,
    all_unreconciled_gl_in_period: allUnreconciledGlInPeriod,
    unreconciled_transfers: unreconciledTransfers,
    payments_diagnostic,
    source_diagnostic: {
      statement_source: stmt.source,
      gl_sources_in_period: [...glSourcesSeen.entries()].map(
        ([name, count]) => ({ name, count }),
      ),
      gl_sources_not_matching: sourcesNotMatched,
      gl_matched_count: candidateGl.length,
    },
  };
}

/**
 * Quick helper for the agent tool — pick a single statement when the
 * agent doesn't have an explicit statement_id. With a query, prefer a
 * source substring match; if nothing matches, fall back to the most
 * recent statement so the panel can still render something useful
 * (the empty-result panel was confusing — looked like no statements
 * existed at all).
 */
export async function findStatementBySource(query) {
  const all = await listStatements({ status: "all" });
  if (all.length === 0) return null;
  const sortedByDateDesc = [...all].sort((a, b) =>
    (toIsoDate(b.statement_date) ?? "").localeCompare(
      toIsoDate(a.statement_date) ?? "",
    ),
  );
  if (!query) return sortedByDateDesc[0];
  const q = String(query).toLowerCase();
  const matches = sortedByDateDesc.filter(
    (s) => s.source && s.source.toLowerCase().includes(q),
  );
  if (matches.length > 0) return matches[0];
  // Query didn't match anything — better to show the most recent
  // statement than nothing at all. Caller can decide what to do.
  return sortedByDateDesc[0];
}
