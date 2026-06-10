<script setup>
import { ref, computed, onMounted, inject } from "vue";
import {
  searchTransactions,
  linkExistingTxnToAwaiting,
} from "../api.js";

const props = defineProps({
  // { id, vendor, amount, currency, date?, reference_number? }
  awaiting: { type: Object, required: true },
});
const emit = defineEmits(["success", "cancel"]);

const token = inject("apiToken");

// Search filter starts with the awaiting's vendor; the user can
// clear or change it. Empty vendor → no filter → recent rows.
const vendorFilter = ref(props.awaiting.vendor || "");
const candidates = ref([]);
const selectedId = ref(null);
const loading = ref(false);
const linking = ref(false);
const error = ref(null);

const awaitingAmount = computed(() =>
  Math.abs(Number(props.awaiting.amount) || 0),
);

function fmt(amount, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function shortDate(d) {
  if (!d) return "—";
  const s = typeof d === "string" ? d : d.toISOString?.() || String(d);
  return s.slice(0, 10);
}

// Other awaitings (besides THIS one) that the candidate txn already
// settles. Multi-link is allowed — these are informational only.
function otherLinks(t) {
  const arr = Array.isArray(t.already_linked_awaitings)
    ? t.already_linked_awaitings
    : [];
  return arr.filter((a) => a.id !== props.awaiting.id);
}
function otherLinkedCount(t) {
  return otherLinks(t).length;
}
function otherLinkedTitle(t) {
  const others = otherLinks(t);
  if (others.length === 0) return "";
  return (
    "Also settles:\n" +
    others.map((a) => `  • ${a.id} — ${a.vendor || "?"} (${fmt(a.amount)})`).join("\n")
  );
}

// Decorate hits with a relevance signal so the user can scan quickly:
//   - amountDelta: |row.amount - awaiting.amount|
//   - exact: amountDelta <= $0.01
//   - daysOff: |row.date - awaiting.date|
// Sort by (exact desc, daysOff asc, date desc as fallback).
const ranked = computed(() => {
  const aw = props.awaiting;
  const awAmount = awaitingAmount.value;
  const awDate = aw.date ? new Date(aw.date).getTime() : null;
  return [...candidates.value]
    .map((t) => {
      const amt = Math.abs(Number(t.amount) || 0);
      const delta = Math.abs(amt - awAmount);
      const tDate = t.date ? new Date(t.date).getTime() : null;
      const daysOff =
        awDate != null && tDate != null
          ? Math.abs(tDate - awDate) / 86400000
          : 9999;
      return {
        ...t,
        _amount_delta: delta,
        _exact: delta <= 0.01,
        _days_off: daysOff,
      };
    })
    .sort((a, b) => {
      if (a._exact !== b._exact) return a._exact ? -1 : 1;
      if (a._days_off !== b._days_off) return a._days_off - b._days_off;
      return (b.date || "").localeCompare(a.date || "");
    });
});

async function loadCandidates() {
  loading.value = true;
  error.value = null;
  try {
    const rows = await searchTransactions(token.value, {
      vendor: vendorFilter.value || undefined,
      limit: 100,
    });
    candidates.value = Array.isArray(rows) ? rows : [];
  } catch (e) {
    error.value = e.message || "Couldn't load transactions.";
  } finally {
    loading.value = false;
  }
}

async function link() {
  if (!selectedId.value) return;
  error.value = null;
  linking.value = true;
  try {
    await linkExistingTxnToAwaiting(
      token.value,
      props.awaiting.id,
      selectedId.value,
    );
    emit("success");
  } catch (e) {
    error.value = e.message || "Link failed.";
  } finally {
    linking.value = false;
  }
}

onMounted(loadCandidates);
</script>

<template>
  <div class="lep-root">
    <p class="lep-hint">
      Pick a transaction that already exists on the right side of the timeline.
      Linking it will mark this invoice as paid and re-attach any invoice
      documents to that transaction.
    </p>

    <div class="lep-search">
      <label>
        <span class="lep-label">Vendor filter</span>
        <input
          v-model="vendorFilter"
          type="text"
          placeholder="(leave blank to see recent)"
          @keyup.enter="loadCandidates"
        />
      </label>
      <button
        class="ghost"
        type="button"
        :disabled="loading"
        @click="loadCandidates"
      >
        {{ loading ? "Searching…" : "Search" }}
      </button>
    </div>

    <p v-if="error" class="lep-error">{{ error }}</p>

    <div v-if="loading" class="lep-empty">Searching…</div>
    <div v-else-if="ranked.length === 0" class="lep-empty">
      No transactions match. Try clearing the vendor filter or use the
      "New payment" tab instead.
    </div>

    <ul v-else class="lep-list">
      <li
        v-for="t in ranked"
        :key="t.id"
        class="lep-row"
        :class="{
          selected: selectedId === t.id,
          exact: t._exact,
        }"
        @click="selectedId = t.id"
      >
        <div class="lep-row-main">
          <span class="mono date">{{ shortDate(t.date) }}</span>
          <strong class="vendor">{{ t.vendor || "—" }}</strong>
          <span class="amount mono" :class="{ 'amt-mismatch': !t._exact }">
            {{ fmt(t.amount, t.currency) }}
          </span>
          <span v-if="t._exact" class="tag tag-exact">exact</span>
          <span
            v-else
            class="tag tag-warn"
            :title="`Awaiting amount is ${fmt(awaitingAmount, awaiting.currency)}`"
          >
            Δ {{ fmt(t._amount_delta, t.currency) }}
          </span>
          <!-- One payment can settle multiple invoices (vendor sends
               two bills, you pay both with one check). Show the
               existing links as informational context, not as a
               warning. Excludes THIS awaiting from the tally so we
               don't show "also pays self" if the user is re-opening
               the picker after a successful link. -->
          <span
            v-if="otherLinkedCount(t) > 0"
            class="tag tag-info"
            :title="otherLinkedTitle(t)"
          >also pays {{ otherLinkedCount(t) }} other<span v-if="otherLinkedCount(t) !== 1">s</span></span>
        </div>
        <div class="lep-row-sub">
          <span class="mono">{{ t.id }}</span>
          <span v-if="t.payment_source"> · {{ t.payment_source }}</span>
          <span v-if="t.category"> · {{ t.category }}</span>
          <span v-if="t.reference_number">
            · ref {{ t.reference_number }}
          </span>
        </div>
      </li>
    </ul>

    <div class="lep-actions">
      <button
        type="button"
        class="ghost"
        :disabled="linking"
        @click="emit('cancel')"
      >Cancel</button>
      <button
        type="button"
        class="primary"
        :disabled="!selectedId || linking"
        @click="link"
      >
        {{ linking ? "Linking…" : "Link to selected" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.lep-root {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.lep-hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.lep-search {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
}

.lep-search label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  flex: 1;
}

.lep-label {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 700;
}

.lep-search input {
  font-size: 0.85rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.lep-error {
  margin: 0;
  font-size: 0.78rem;
  color: var(--danger);
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
  padding: 0.35rem 0.55rem;
}

.lep-empty {
  font-size: 0.85rem;
  color: var(--text-muted);
  padding: 0.5rem 0;
}

.lep-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  max-height: 320px;
  overflow-y: auto;
}

.lep-row {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.45rem 0.6rem;
  cursor: pointer;
  background: var(--surface);
  font-size: 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.lep-row:hover {
  border-color: var(--accent);
  background: #fafaf5;
}

.lep-row.selected {
  border-color: var(--accent);
  background: #eff6ff;
}

.lep-row.exact {
  border-left: 3px solid var(--ok);
}

.lep-row-main {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.lep-row-main .date {
  color: var(--text-muted);
  font-size: 0.72rem;
}

.lep-row-main .vendor {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lep-row-main .amount {
  font-weight: 600;
}

.lep-row-main .amt-mismatch {
  color: #b45309;
}

.lep-row-sub {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.tag {
  font-size: 0.6rem;
  font-family: var(--font-mono);
  font-weight: 700;
  padding: 0 5px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.tag-exact {
  background: #f0fdf4;
  color: var(--ok);
  border: 1px solid #bbf7d0;
}

.tag-warn {
  background: #fffbeb;
  color: #92400e;
  border: 1px solid #fde68a;
}

.tag-info {
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
}

.lep-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.4rem;
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.8rem;
  padding: 0.35rem 0.7rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover:not(:disabled) {
  background: #f5f5f0;
}

button.primary {
  font-size: 0.82rem;
  padding: 0.4rem 0.85rem;
}

button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.mono {
  font-family: var(--font-mono);
}
</style>
