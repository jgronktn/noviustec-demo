// One-off (idempotent) repair: link existing Transfers to their settling
// AwaitingPayment rows when mark-as-transfer was used BEFORE the auto-link
// logic landed in routes.js.
//
// Heuristic — matches the live findOutstandingAwaitingTransfer():
//   - awaiting.status === "awaiting"
//   - awaiting.payment_kind === "transfer"
//   - awaiting.amount within $0.01 of the transfer's amount
//   - awaiting.vendor matches Transfer.to_source OR Transfer.from_source by
//     case-insensitive name OR last-4 marker
// Links only when EXACTLY ONE awaiting matches (ambiguous matches are
// flagged but skipped — fix by hand).
//
// USAGE:
//   node scripts/relink-orphan-transfers.js --dry-run    # show what it would do
//   node scripts/relink-orphan-transfers.js              # apply

import { existsSync } from "node:fs";
import * as path from "node:path";
import {
  listTransfers,
  listAwaiting,
  listStatements,
  updateTransfer,
  updateAwaiting,
  markAwaitingPaid,
} from "../src/ledger/index.js";

const ENV_PATH = path.resolve(import.meta.dirname, "..", ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const DRY_RUN = process.argv.includes("--dry-run");

function extractLast4(s) {
  if (!s) return null;
  const m = String(s).match(/(?:••?|\*\*|-)\s*(\d{4})\b/);
  return m ? m[1] : null;
}
function sameAccountName(a, b) {
  if (!a || !b) return false;
  const aa = String(a).toLowerCase().trim();
  const bb = String(b).toLowerCase().trim();
  if (aa === bb) return true;
  const la = extractLast4(a);
  const lb = extractLast4(b);
  return !!(la && lb && la === lb);
}

function findUniqueSubsetSummingTo(items, target, tolerance = 0.01) {
  const N = items.length;
  if (N === 0 || N > 16) return null;
  let foundMask = -1;
  for (let mask = 1; mask < 1 << N; mask++) {
    let sum = 0;
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) sum += Number(items[i].amount);
    }
    if (Math.abs(sum - target) <= tolerance) {
      if (foundMask !== -1) return null;
      foundMask = mask;
    }
  }
  if (foundMask === -1) return null;
  const out = [];
  for (let i = 0; i < N; i++) {
    if (foundMask & (1 << i)) out.push(items[i]);
  }
  return out;
}

const transfers = await listTransfers();
// Scan ALL statuses, not just "awaiting" — the original carry-forward
// logic in statement import wrote off prior balances without checking
// whether they'd been settled by a transfer first, so many "written_off"
// rows are actually paid in fact.
const awaitings = await listAwaiting({ status: "all" });
const allStatements = await listStatements({ status: "all" });

const unlinkedTransfers = transfers.filter((t) => !t.awaiting_id);

let linkedSets = 0;
let linkedTransfersCount = 0;
let linkedOverpayments = 0;
const usedTransferIds = new Set();

// Helper: same next-period statement lookup the live endpoint uses.
function findNextStatementForAwaiting(aw) {
  if (!aw?.statement_id) return null;
  const origin = allStatements.find((s) => s.id === aw.statement_id);
  if (!origin?.period_end) return null;
  const originEnd = new Date(origin.period_end);
  const after = allStatements
    .filter(
      (s) =>
        s.id !== origin.id &&
        sameAccountName(s.source, origin.source) &&
        s.period_start &&
        new Date(s.period_start) >= originEnd,
    )
    .sort((a, b) => new Date(a.period_start) - new Date(b.period_start));
  return after[0] ?? null;
}

// Eligible awaitings: transfer-kind, no settling transfer yet linked,
// status NOT "paid" (already-paid means it's already showing the
// correct state). We DO include "written_off" because those were
// auto-marked at carry-forward time without checking if they'd been
// paid first.
const awaitingsSorted = [...awaitings]
  .filter(
    (aw) =>
      (aw.payment_kind || "expense") === "transfer" &&
      !aw.paid_transfer_id &&
      aw.status !== "paid",
  )
  .sort((a, b) => Number(a.amount) - Number(b.amount));

// ── Pass 1: exact subset-sum (within $0.01) ─────────────────────────
for (const aw of awaitingsSorted) {
  const eligible = unlinkedTransfers.filter(
    (t) =>
      !usedTransferIds.has(t.id) && sameAccountName(t.to_source, aw.vendor),
  );
  if (eligible.length === 0) continue;
  const target = Math.abs(Number(aw.amount));
  const subset = findUniqueSubsetSummingTo(eligible, target, 0.01);
  if (!subset) continue;
  console.log(
    `  ${subset.length === 1 ? "1:1" : `${subset.length}:1`} exact: awaiting ${aw.id} (${aw.vendor}, $${aw.amount}) via [${subset.map((t) => `${t.id}/$${Math.abs(Number(t.amount))}`).join(", ")}]`,
  );
  if (!DRY_RUN) {
    for (const t of subset) {
      await updateTransfer(t.id, { awaiting_id: aw.id });
    }
    await markAwaitingPaid(aw.id, { paid_transfer_id: subset[0].id });
  }
  for (const t of subset) usedTransferIds.add(t.id);
  linkedSets++;
  linkedTransfersCount += subset.length;
}

// ── Pass 2: single-transfer overpayment within carry-forward window ──
for (const aw of awaitingsSorted) {
  // Skip if pass 1 already settled this awaiting.
  if (aw.paid_transfer_id) continue;
  const awAmount = Math.abs(Number(aw.amount));
  const eligible = unlinkedTransfers.filter(
    (t) =>
      !usedTransferIds.has(t.id) &&
      sameAccountName(t.to_source, aw.vendor) &&
      Math.abs(Number(t.amount)) >= awAmount,
  );
  if (eligible.length === 0) continue;
  const nextStmt = findNextStatementForAwaiting(aw);
  if (!nextStmt) continue;
  const nextCharges = Number(nextStmt.total_charges);
  if (!Number.isFinite(nextCharges) || nextCharges < 0) continue;
  const upperBound = awAmount + nextCharges;
  const inWindow = eligible.filter(
    (t) => Math.abs(Number(t.amount)) <= upperBound + 0.01,
  );
  if (inWindow.length !== 1) continue; // ambiguous or none
  const t = inWindow[0];
  const trAmount = Math.abs(Number(t.amount));
  const overpayment = Math.round((trAmount - awAmount) * 100) / 100;
  console.log(
    `  1:1 overpay: awaiting ${aw.id} (${aw.vendor}, $${aw.amount}) via ${t.id} ($${trAmount}) — overpaid $${overpayment.toFixed(2)}, applied to next statement ${nextStmt.id}`,
  );
  if (!DRY_RUN) {
    await updateTransfer(t.id, { awaiting_id: aw.id });
    const existingNotes = aw.notes || "";
    const overNote = `Overpaid by $${overpayment.toFixed(2)} via xfer ${t.id} — applied to next statement (${nextStmt.id}).`;
    const combinedNotes = existingNotes
      ? `${existingNotes}\n${overNote}`
      : overNote;
    await updateAwaiting(aw.id, { notes: combinedNotes });
    await markAwaitingPaid(aw.id, { paid_transfer_id: t.id });
  }
  usedTransferIds.add(t.id);
  linkedSets++;
  linkedTransfersCount++;
  linkedOverpayments++;
}

// ── Pass 3: carry-forward chain settlement ──────────────────────────
// A written_off awaiting whose chain terminates in a paid awaiting
// was effectively paid (the unpaid leftover was carried into the next
// statement, eventually paid). Propagate the chain's settling transfer
// down to the original written_off awaiting and flip its status to
// paid, with a note explaining the chain.
//
// The "Carries forward: <oldId>" annotation lives on the NEW awaiting
// (set at carry-forward time). Build a forward chain map: oldId → newId.
//
// Re-read state after pass 1/2 so we see the freshly-paid awaitings.
const refreshedAwaitings = await listAwaiting({ status: "all" });
const chainMap = new Map(); // oldId → newId (which awaiting carries it)
for (const aw of refreshedAwaitings) {
  const notes = String(aw.notes || "");
  // Notes can use either " | " (carry-forward writer) or "\n" (overpayment
  // appender) as a separator between annotation fields. Stop at either so
  // the captured group is just the carries-forward id list.
  const m = notes.match(/Carries forward:\s*([^|\n]+)/);
  if (!m) continue;
  const carriedIds = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^apw_/.test(s));
  for (const oldId of carriedIds) chainMap.set(oldId, aw.id);
}

function walkChainToPaid(startId) {
  const visited = new Set();
  let current = startId;
  const path = [];
  while (!visited.has(current)) {
    visited.add(current);
    const aw = refreshedAwaitings.find((a) => a.id === current);
    if (!aw) return null;
    path.push(aw);
    if (aw.status === "paid" && aw.paid_transfer_id) {
      return { terminalAwaiting: aw, path };
    }
    const next = chainMap.get(current);
    if (!next) return null;
    current = next;
  }
  return null;
}

let chainLinked = 0;
const chainCandidates = refreshedAwaitings.filter(
  (aw) =>
    aw.status === "written_off" &&
    (aw.payment_kind || "expense") === "transfer" &&
    !aw.paid_transfer_id,
);
for (const aw of chainCandidates) {
  const result = walkChainToPaid(aw.id);
  if (!result) continue;
  const { terminalAwaiting, path } = result;
  console.log(
    `  chain settle: ${aw.id} ($${aw.amount}, ${aw.vendor}) → carried forward through ${path.length - 1} statement(s) → settled by ${terminalAwaiting.paid_transfer_id} via ${terminalAwaiting.id}`,
  );
  if (!DRY_RUN) {
    const existingNotes = aw.notes || "";
    const chainNote = `Paid via carry-forward chain — settled when ${terminalAwaiting.id} was paid by xfer ${terminalAwaiting.paid_transfer_id}.`;
    const combinedNotes = existingNotes
      ? `${existingNotes}\n${chainNote}`
      : chainNote;
    await updateAwaiting(aw.id, { notes: combinedNotes });
    await markAwaitingPaid(aw.id, {
      paid_transfer_id: terminalAwaiting.paid_transfer_id,
    });
  }
  chainLinked++;
}

// Pass 4 (was pass 2): show the orphans the script left behind, with
// diagnostic hints so the user can decide whether the data is legitimately
// unmatched.
const remaining = unlinkedTransfers.filter((t) => !usedTransferIds.has(t.id));
for (const t of remaining) {
  const amount = Math.abs(Number(t.amount));
  const sameVendor = awaitings.filter(
    (aw) =>
      sameAccountName(aw.vendor, t.to_source) ||
      sameAccountName(aw.vendor, t.from_source),
  );
  console.log(
    `  unlinked: transfer ${t.id} ($${amount}, ${t.from_source} → ${t.to_source}, ${t.date && (typeof t.date === "string" ? t.date.slice(0, 10) : new Date(t.date).toISOString().slice(0, 10))})`,
  );
  if (sameVendor.length > 0) {
    console.log(
      `    vendor-matching awaitings: ${sameVendor.map((a) => `${a.id}/$${a.amount}`).join(", ")}`,
    );
  }
}

console.log("");
console.log(
  `Linked subsets:        ${linkedSets}${DRY_RUN ? " (dry-run, not written)" : ""}`,
);
console.log(`  of which overpay:    ${linkedOverpayments}`);
console.log(`Linked transfers:      ${linkedTransfersCount}`);
console.log(`Chain settlements:     ${chainLinked}`);
console.log(`Still unlinked:        ${remaining.length}`);
