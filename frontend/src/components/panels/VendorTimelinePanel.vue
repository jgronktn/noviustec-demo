<script setup>
import { computed, ref, inject } from "vue";
import AddPaymentDialog from "../AddPaymentDialog.vue";
import AddDepositDialog from "../AddDepositDialog.vue";

const props = defineProps({
  data: { type: Object, required: true },
});

// Provided by App.vue. Optional so the component still renders fine in
// contexts where the dialogs aren't mounted.
const openEditDialog = inject("openEditDialog", null);
const signalLedgerChange = inject("signalLedgerChange", () => {});

// Quick-add modals triggered by the buttons in the right-side header.
// Direct-write (no agent proposal step) for fast manual entry of
// checks/card charges (payment) or deposits/revenue (deposit).
const showAddPayment = ref(false);
const showAddDeposit = ref(false);

function onAddPaymentSuccess() {
  showAddPayment.value = false;
  signalLedgerChange();
}
function onAddDepositSuccess() {
  showAddDeposit.value = false;
  signalLedgerChange();
}

// Pair-highlight state kept (currently unused — click-to-highlight was
// retired in favor of click-to-edit; keeping the ref so a future
// secondary gesture (e.g. shift-click) can resurrect it cheaply).
const highlightedLinkId = ref(null);

// link_id → number of cards sharing it. >1 means there's an actual pair
// to highlight (otherwise the click would just highlight the clicked
// card alone, which is pointless).
const linkCounts = computed(() => {
  const m = new Map();
  for (const row of props.data.rows) {
    for (const ev of [...row.left, ...row.right]) {
      if (ev.link_id) m.set(ev.link_id, (m.get(ev.link_id) ?? 0) + 1);
    }
  }
  return m;
});

function hasLinkedSibling(ev) {
  return !!ev.link_id && (linkCounts.value.get(ev.link_id) ?? 0) > 1;
}

function isLinkedActive(ev) {
  return !!ev.link_id && ev.link_id === highlightedLinkId.value;
}

function canEdit(ev) {
  if (!openEditDialog) return false;
  // Right-side payment cards always edit the GL row.
  if (ev.kind === "payment") return true;
  // Right-side transfer cards aren't editable yet (no edit-transfer
  // dialog), but they ARE clickable in the sense they're informational.
  if (ev.kind === "transfer") return false;
  // Left awaiting cards (any status) → edit AwaitingPayment. Unpaid ones
  // get a 'Record payment →' button inside the edit dialog.
  if (ev.source === "awaiting") return true;
  // Left GL doc cards → edit the underlying GL row.
  if (ev.source === "gl") return true;
  return false;
}

function isCardInteractive(ev) {
  return canEdit(ev);
}

function effectiveStatus(ev) {
  return ev.status;
}

async function handleCardClick(ev) {
  if (!openEditDialog) return;

  if (ev.kind === "payment") {
    await openEditDialog({ kind: "transaction", id: ev.id });
    return;
  }

  if (ev.source === "awaiting") {
    // All awaiting cards open the edit dialog. For unpaid ones, the
    // dialog surfaces a 'Record payment →' button in its header.
    await openEditDialog({ kind: "awaiting", id: ev.id });
    return;
  }

  if (ev.source === "gl") {
    // Left-side GL doc card. The backend sends txn_id explicitly when
    // emitting per-document cards; the fallback path uses `${txn}-doc`.
    const txnId = ev.txn_id ?? ev.id.replace(/-doc$/, "");
    await openEditDialog({ kind: "transaction", id: txnId });
    return;
  }
}

function fmt(amount, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function shortMonth(yyyyMm) {
  // yyyyMm = "2026-05" → "May 2026"
  const [y, m] = yyyyMm.split("-").map(Number);
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${names[m - 1]} ${y}`;
}

function invStatusClass(status) {
  return `inv-${status}`;
}

function kindLabel(ev) {
  // Card-balance obligations (awaiting-transfer auto-created from a
  // credit-card statement's closing balance) get their own label so they
  // don't read as a vendor invoice.
  if (ev && ev.is_transfer_obligation) return "Card balance";
  const kind = typeof ev === "string" ? ev : ev?.kind;
  if (kind === "invoice") return "Invoice";
  if (kind === "receipt") return "Receipt";
  if (kind === "payment") return "Payment";
  if (kind === "deposit") return "Deposit";
  if (kind === "transfer") return "Transfer";
  if (kind === "statement") return "Statement";
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "—";
}

// Interleave month boundary ticks between data rows so a small horizontal
// label divides activity by month. Rows are already newest-first; the
// first row of each month gets a tick rendered above it. We also slot a
// red TODAY marker at the boundary between future and past activity
// (which, for typical ledger data, means at the very top).
const todayIso = computed(
  () => props.data.summary?.as_of || new Date().toISOString().slice(0, 10),
);

// Group rows by month so each month becomes a wrapped section. The
// section gets a CSS `min-height` to enforce at least 150px of vertical
// distance between consecutive month tags, regardless of how few rows
// the month contains. Within a section we also slot in the red TODAY
// marker at the boundary between future and past activity.
const monthGroups = computed(() => {
  const groups = [];
  let current = null;
  let todayInserted = false;

  const ensureGroup = (month) => {
    if (!current || current.month !== month) {
      current = { month, key: `m-${month}`, items: [] };
      groups.push(current);
    }
    return current;
  };

  for (const row of props.data.rows) {
    const month = (row.date || "").slice(0, 7);
    if (!month) continue;
    const group = ensureGroup(month);
    if (!todayInserted && row.date <= todayIso.value) {
      group.items.push({ type: "today", date: todayIso.value, key: "today" });
      todayInserted = true;
    }
    group.items.push({ type: "row", row, key: `row-${row.date}` });
  }

  // All rows are future-dated → drop the TODAY marker at the bottom of
  // the last (oldest = earliest in the future) group.
  if (!todayInserted && groups.length > 0) {
    groups[groups.length - 1].items.push({
      type: "today",
      date: todayIso.value,
      key: "today",
    });
  }
  return groups;
});
</script>

<template>
  <div class="vt-root">
    <!-- Header is intentionally tiny. Single-vendor mode shows the
         canonical name; global mode shows 'All activity' plus a count.
         No summary tiles — the timeline itself is the answer. -->
    <header class="vt-head">
      <h3 v-if="data.is_global" class="vt-vendor">All activity</h3>
      <h3 v-else class="vt-vendor">{{ data.vendor }}</h3>
      <span v-if="data.is_global" class="vt-match">
        {{ data.summary.distinct_vendors }} vendor<span v-if="data.summary.distinct_vendors !== 1">s</span>
        · {{ data.summary.invoice_count + data.summary.payment_count }} event<span v-if="data.summary.invoice_count + data.summary.payment_count !== 1">s</span>
      </span>
      <span v-else-if="data.query !== data.vendor" class="vt-match">
        matched “{{ data.query }}”
      </span>
    </header>

    <div v-if="data.rows.length === 0" class="vt-empty">
      No invoices or payments recorded for this vendor.
    </div>

    <div v-else class="vt-timeline">
      <!-- Per-side running totals, pinned above the top month tag.
           The statement_timeline view suppresses these because the
           Invoices/Payments framing doesn't apply to card balances
           and bank statements. -->
      <div v-if="!data.summary?.hide_side_totals" class="vt-totals">
        <div class="vt-side vt-left">
          <div class="vt-total vt-total-left">
            <span class="vt-total-label">Invoices &amp; Receipts</span>
            <span class="vt-total-amount">{{ fmt(data.summary.total_left) }}</span>
          </div>
        </div>
        <div class="vt-axis vt-axis-spacer" />
        <div class="vt-side vt-right">
          <div class="vt-total-stack">
            <div class="vt-total vt-total-right">
              <span class="vt-total-label">Payments out</span>
              <span class="vt-total-amount">{{ fmt(data.summary.total_paid ?? data.summary.total_right) }}</span>
              <button
                class="vt-add-payment"
                type="button"
                title="Quick-add a payment (check, card, ACH, wire, cash)"
                @click="showAddPayment = true"
              >+ Add payment</button>
            </div>
            <div class="vt-total vt-total-deposits">
              <span class="vt-total-label">Income</span>
              <span class="vt-total-amount mono">{{ fmt(data.summary.total_deposits ?? 0) }}</span>
              <button
                class="vt-add-deposit"
                type="button"
                title="Quick-add a deposit (revenue, investor capital, refund, interest, etc.)"
                @click="showAddDeposit = true"
              >+ Add deposit</button>
            </div>
            <div
              class="vt-total vt-total-cash"
              :class="{
                'vt-cash-positive': (data.summary.total_cash ?? 0) > 0,
                'vt-cash-negative': (data.summary.total_cash ?? 0) < 0,
              }"
            >
              <span class="vt-total-label">Cash</span>
              <span class="vt-total-amount mono">{{ fmt(data.summary.total_cash ?? 0) }}</span>
              <span class="vt-cash-note">Income − Payments out</span>
            </div>
          </div>
        </div>
      </div>

      <section
        v-for="group in monthGroups"
        :key="group.key"
        class="vt-month"
      >
        <!-- Month label sits at the top of its section -->
        <div class="vt-tick">
          <span class="vt-tick-bar" />
          <span class="vt-tick-label">{{ shortMonth(group.month) }}</span>
          <span class="vt-tick-bar" />
        </div>

        <template v-for="item in group.items" :key="item.key">
          <!-- Today marker: solid red dot on the axis, label to the right -->
          <div v-if="item.type === 'today'" class="vt-today">
            <div class="vt-side vt-left" />
            <div class="vt-axis">
              <div class="vt-today-dot" />
            </div>
            <div class="vt-side vt-right">
              <span class="vt-today-label">
                <span class="vt-today-word">TODAY</span>
                <span class="vt-today-date">{{ item.date }}</span>
              </span>
            </div>
          </div>

          <!-- Data row: left = invoices/receipts, right = payments -->
          <div v-else class="vt-row">
          <div class="vt-side vt-left">
            <div
              v-for="ev in item.row.left"
              :key="ev.id"
              class="vt-card vt-card-left"
              :class="[
                invStatusClass(effectiveStatus(ev)),
                { 'vt-card-clickable': isCardInteractive(ev) },
                { 'vt-card-linked': isLinkedActive(ev) },
                { 'vt-card-transfer': ev.is_transfer_obligation },
              ]"
              :title="canEdit(ev) ? 'Click to edit' : (ev.description || '')"
              @click="handleCardClick(ev)"
            >
              <span class="vt-card-kind">{{ kindLabel(ev) }}</span>
              <span v-if="data.is_global" class="vt-card-vendor">{{ ev.vendor }}</span>
              <span v-if="ev.reference_number" class="vt-card-ref">
                {{ ev.reference_number }}
              </span>
              <span class="vt-card-amount">{{ fmt(ev.amount, ev.currency) }}</span>
              <span
                v-if="ev.status === 'awaiting' || ev.status === 'overdue'"
                class="vt-card-age"
              >
                {{ ev.days_outstanding }}d
                <template v-if="ev.status === 'overdue'">overdue</template>
              </span>
              <span
                v-if="ev.statement_matched"
                class="vt-card-stmt-check"
                title="Settling transfer or payment is reconciled against a statement line"
              >✓</span>
            </div>
          </div>

          <div class="vt-axis">
            <div class="vt-dot" />
            <span class="vt-date">{{ item.row.date }}</span>
          </div>

          <div class="vt-side vt-right">
            <div
              v-for="ev in item.row.right"
              :key="ev.id"
              class="vt-card vt-card-right"
              :class="[
                { 'vt-card-clickable': hasLinkedSibling(ev) || canEdit(ev) },
                { 'vt-card-linked': isLinkedActive(ev) },
                { 'vt-card-transfer-right': ev.kind === 'transfer' },
                { 'vt-card-deposit': ev.entry_type === 'income' },
                { 'vt-card-statement-right': ev.kind === 'statement' },
              ]"
              :title="canEdit(ev) ? 'Click to edit' : (ev.description || '')"
              @click="handleCardClick(ev)"
            >
              <span class="vt-card-kind">{{ kindLabel(ev) }}</span>
              <span v-if="data.is_global" class="vt-card-vendor">{{ ev.vendor }}</span>
              <!-- Transfers: show "<from> → <to>"; payments: show payment_source. -->
              <span
                v-if="ev.kind === 'transfer' && (ev.from_source || ev.to_source)"
                class="vt-card-source"
              >{{ ev.from_source || "?" }} → {{ ev.to_source || "?" }}</span>
              <span
                v-else-if="ev.payment_source"
                class="vt-card-source"
              >{{ ev.payment_source }}</span>
              <span class="vt-card-amount">{{ fmt(ev.amount, ev.currency) }}</span>
              <span v-if="ev.category" class="vt-card-cat">{{ ev.category }}</span>
              <span
                v-if="ev.statement_matched"
                class="vt-card-stmt-check"
                title="Reconciled against a statement line"
              >✓</span>
            </div>
          </div>
        </div>
        </template>
      </section>
    </div>

    <!-- Quick-add payment / deposit modals triggered from the right-
         side header. Lives at root so fixed-position backdrops cover
         the whole canvas, not just the timeline. -->
    <AddPaymentDialog
      v-if="showAddPayment"
      @success="onAddPaymentSuccess"
      @cancel="showAddPayment = false"
    />
    <AddDepositDialog
      v-if="showAddDeposit"
      @success="onAddDepositSuccess"
      @cancel="showAddDeposit = false"
    />
  </div>
</template>

<style scoped>
.vt-root {
  position: relative;
  display: flex;
  flex-direction: column;
  /* Take up the canvas — the dashboard pane scrolls when content overflows. */
  min-height: calc(100vh - 200px);
}

/* ── Header ────────────────────────────────────────────────────────── */
.vt-head {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding-bottom: 0.75rem;
  margin-bottom: 0.25rem;
  border-bottom: 1px solid var(--border);
}

.vt-vendor {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.vt-match {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
}

.vt-empty {
  color: var(--text-muted);
  font-size: 0.85rem;
  padding: 1rem 0;
}

/* ── Timeline ──────────────────────────────────────────────────────── */
.vt-timeline {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
}

/* Continuous center line behind everything. */
.vt-timeline::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  background: var(--border);
  transform: translateX(-50%);
  z-index: 0;
}

/* ── Totals strip (pinned above the first month section) ──────────────
   Two side-aligned cards reporting the literal sum of every card on
   each side of the line. */
.vt-totals {
  display: grid;
  grid-template-columns: 1fr 110px 1fr;
  align-items: stretch;
  padding-bottom: 0.85rem;
  margin-bottom: 0.35rem;
  border-bottom: 1px dashed var(--border);
}

.vt-axis-spacer {
  /* center column is intentionally empty; the line still draws through */
}

.vt-total {
  display: inline-flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.5rem 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.vt-total-left {
  /* match the left-column right-alignment of left-side cards */
  align-self: flex-end;
}

.vt-total-right {
  align-self: flex-start;
}

/* Two-stripe right-side totals: Payments out on the left, Income on
   the right, side-by-side on the same horizontal plane. Each stripe
   has its own quick-add button. align-items: stretch makes all three
   cards take the height of the tallest, and the margin-top: auto
   rule below aligns each card's bottom element (button or note) on
   the same horizontal line. */
.vt-total-stack {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* In the right-side totals row only, force the last child of each
   card (the + Add button or the cash note) to the bottom of the
   card so they line up across cards. Scoped to vt-total-stack so
   the left-side total isn't affected. */
.vt-total-stack > .vt-total > *:last-child {
  margin-top: auto;
}

.vt-total-deposits {
  align-self: flex-start;
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.vt-total-deposits .vt-total-label {
  color: var(--ok);
}

/* Net cash flow card — positive (green tint), negative (red tint),
   or neutral (gray when zero). Sits at the right edge of the totals
   row as a quick-glance "did we make or lose money this period". */
.vt-total-cash {
  align-self: flex-start;
  border-color: var(--border);
  background: var(--surface);
}

.vt-total-cash.vt-cash-positive {
  border-color: #bbf7d0;
  background: #ecfdf5;
}

.vt-total-cash.vt-cash-positive .vt-total-label,
.vt-total-cash.vt-cash-positive .vt-total-amount {
  color: var(--ok);
}

.vt-total-cash.vt-cash-negative {
  border-color: #fecaca;
  background: #fef2f2;
}

.vt-total-cash.vt-cash-negative .vt-total-label,
.vt-total-cash.vt-cash-negative .vt-total-amount {
  color: var(--danger);
}

.vt-cash-note {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-style: italic;
  /* Match the vertical padding of the + Add buttons so the bottom
     edge sits on the same horizontal line. */
  padding: 0.3rem 0;
}

.vt-add-payment,
.vt-add-deposit {
  margin-top: 0.35rem;
  font-size: 0.7rem;
  padding: 0.3rem 0.6rem;
  background: var(--surface);
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
  align-self: flex-start;
  transition: background 0.15s, color 0.15s;
}

.vt-add-payment {
  border: 1px solid var(--accent);
  color: var(--accent);
}

.vt-add-payment:hover {
  background: var(--accent);
  color: white;
}

.vt-add-deposit {
  border: 1px solid var(--ok);
  color: var(--ok);
}

.vt-add-deposit:hover {
  background: var(--ok);
  color: white;
}

.vt-total-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--text-muted);
}

.vt-total-amount {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text);
}

@media (max-width: 720px) {
  .vt-totals {
    grid-template-columns: 1fr 80px 1fr;
  }
  .vt-total-amount {
    font-size: 1rem;
  }
}

/* ── Month section ────────────────────────────────────────────────────
   Each month is wrapped in a section so we can guarantee at least 150px
   of vertical distance between consecutive month tags, regardless of
   how few rows the month contains. The center line sits behind via the
   parent's ::before, so spacing the sections just spaces the ticks. */
.vt-month {
  display: flex;
  flex-direction: column;
  min-height: 150px;
}

/* ── Month tick ────────────────────────────────────────────────────── */
.vt-tick {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0;
  position: relative;
  z-index: 1;
}

.vt-tick-bar {
  height: 1px;
  background: var(--border);
  width: 100%;
}

.vt-tick-label {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  background: var(--bg);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  white-space: nowrap;
}

/* ── Today marker ──────────────────────────────────────────────────── */
.vt-today {
  display: grid;
  grid-template-columns: 1fr 110px 1fr;
  align-items: center;
  padding: 0.4rem 0;
  position: relative;
  z-index: 2;
}

/* Solid red dot on the axis — mirrors the .vt-dot shape but fully filled. */
.vt-today-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--danger);
  border: 2px solid var(--danger);
  box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.18);
}

.vt-today-label {
  display: inline-flex;
  align-items: baseline;
  gap: 0.45rem;
  padding-left: 0.6rem; /* aligns with the side gutter spacing */
  white-space: nowrap;
}

.vt-today-word {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--danger);
}

.vt-today-date {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--text-muted);
}

@media (max-width: 720px) {
  .vt-today {
    grid-template-columns: 1fr 80px 1fr;
  }
}

/* ── Data row ──────────────────────────────────────────────────────── */
.vt-row {
  display: grid;
  grid-template-columns: 1fr 110px 1fr;
  align-items: center;
  padding: 0.3rem 0;
  position: relative;
  z-index: 1;
}

.vt-side {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}

.vt-left {
  align-items: flex-end;
  padding-right: 0.6rem;
}

.vt-right {
  align-items: flex-start;
  padding-left: 0.6rem;
}

/* Date axis */
.vt-axis {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  position: relative;
  z-index: 2;
}

.vt-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px solid var(--accent);
}

.vt-date {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-muted);
  background: var(--bg);
  padding: 0 4px;
  white-space: nowrap;
}

/* ── Card (single line) ────────────────────────────────────────────── */
.vt-card {
  display: inline-flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.3rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.78rem;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  transition: transform 0.08s ease-out, box-shadow 0.08s ease-out;
}

.vt-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
}

.vt-card-clickable {
  cursor: pointer;
}

.vt-card-clickable:hover {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  border-color: var(--accent);
}

/* Pair-highlight: clicking an invoice/receipt card or its payment card
   lights up every card sharing the same link_id. Wins over the resting
   color so the link is unmistakable. */
.vt-card-linked {
  border-color: var(--accent) !important;
  box-shadow:
    0 0 0 2px var(--accent),
    0 4px 10px rgba(59, 130, 246, 0.18);
  transform: translateY(-1px);
  z-index: 3;
  position: relative;
}

.vt-card-just-paid {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--ok);
  flex-shrink: 0;
}

/* Invoice / receipt color coding (subtle) */
.vt-card-left.inv-paid {
  background: #f8f8f4;
  border-color: #e5e7eb;
  color: var(--text-muted);
}
.vt-card-left.inv-awaiting {
  background: #fffbeb;
  border-color: #fde68a;
}
.vt-card-left.inv-overdue {
  background: #fef2f2;
  border-color: #fecaca;
  color: #b91c1c;
}
.vt-card-left.inv-written_off,
.vt-card-left.inv-rejected {
  background: #f8f8f4;
  border-color: #e5e7eb;
  opacity: 0.55;
}

/* Card-balance obligation (awaiting-transfer from a card statement).
   Distinct purple treatment so it doesn't read as a vendor invoice —
   wins over the inv-* state colors above (specificity tie, source-order
   precedence). When paid/written-off, the inv-* styles take over so
   the card visibly settles. */
.vt-card-left.vt-card-transfer.inv-awaiting,
.vt-card-left.vt-card-transfer.inv-overdue {
  background: #f5f3ff;
  border-color: #c4b5fd;
  color: var(--text);
}
.vt-card-left.vt-card-transfer .vt-card-kind {
  color: #6d28d9;
}

.vt-card-right {
  background: #eff6ff;
  border-color: #bfdbfe;
}

/* Right-side Transfer card — purple to match the card-balance left card,
   making the obligation→settlement pair visually correlated. */
.vt-card-right.vt-card-transfer-right {
  background: #f5f3ff;
  border-color: #c4b5fd;
}

.vt-card-right.vt-card-transfer-right .vt-card-kind {
  color: #6d28d9;
}

/* Right-side Deposit card — green to distinguish from blue payments,
   matches the "Deposits in" total stripe at the top. */
.vt-card-right.vt-card-deposit {
  background: #f0fdf4;
  border-color: #bbf7d0;
  border-left: 3px solid var(--ok);
}

.vt-card-right.vt-card-deposit .vt-card-kind {
  color: var(--ok);
}

.vt-card-right.vt-card-deposit .vt-card-amount {
  color: var(--ok);
}

/* Right-side Statement card — neutral gray styling so bank
   statements are informational and don't blend with blue payment
   cards or green deposit cards. */
.vt-card-right.vt-card-statement-right {
  background: #f8f8f4;
  border-color: #e5e7eb;
  border-left: 3px solid #9ca3af;
}

.vt-card-right.vt-card-statement-right .vt-card-kind {
  color: #4b5563;
}

.vt-card-right.vt-card-statement-right .vt-card-amount {
  color: #4b5563;
  font-weight: 500;
}

.vt-card-kind {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  color: var(--text-muted);
  flex-shrink: 0;
}

.vt-card-vendor {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 160px;
}

.vt-card-ref {
  font-family: var(--font-mono);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.vt-card-amount {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
}

.inv-paid .vt-card-amount {
  color: var(--text-muted);
}

.vt-card-age {
  font-size: 0.7rem;
  color: var(--warn);
  flex-shrink: 0;
}

.vt-card-stmt-check {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--ok);
  flex-shrink: 0;
  line-height: 1;
}

.inv-overdue .vt-card-age {
  color: #b91c1c;
  font-weight: 600;
}

.vt-card-source {
  font-family: var(--font-mono);
  color: #1d4ed8;
  font-weight: 500;
  flex-shrink: 0;
}

.vt-card-cat {
  font-style: italic;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

@media (max-width: 720px) {
  .vt-row {
    grid-template-columns: 1fr 80px 1fr;
  }
  .vt-card {
    font-size: 0.72rem;
    padding: 0.25rem 0.5rem;
    gap: 0.35rem;
  }
}
</style>
