<script setup>
import { ref, computed, inject } from "vue";

const props = defineProps({
  data: { type: Object, required: true },
});

const openPaymentDialog = inject("openPaymentDialog", null);

const paidIds = ref(new Set());

async function recordPaymentClick(row) {
  if (!openPaymentDialog) return;
  const paid = await openPaymentDialog({
    id: row.id,
    vendor: row.vendor,
    amount: row.amount,
    currency: row.currency,
    reference_number: row.reference_number,
    date: row.date,
    payment_kind: row.payment_kind,
  });
  if (paid) {
    const next = new Set(paidIds.value);
    next.add(row.id);
    paidIds.value = next;
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

function ageClass(days) {
  if (days == null) return "";
  if (days >= 60) return "age-overdue";
  if (days >= 30) return "age-late";
  return "age-fresh";
}

const unpaidEntries = computed(() =>
  props.data.entries.filter((e) => !paidIds.value.has(e.id)),
);
const unpaidCount = computed(() => unpaidEntries.value.length);
const unpaidTotal = computed(() =>
  unpaidEntries.value.reduce((s, e) => s + (Number(e.amount) || 0), 0),
);
</script>

<template>
  <div class="awaiting-panel">
    <div class="summary">
      <span class="total">{{ fmt(unpaidTotal) }}</span>
      <span class="meta">
        across {{ unpaidCount }} unpaid invoice<span v-if="unpaidCount !== 1">s</span>
      </span>
    </div>

    <div v-if="data.entries.length === 0" class="empty">
      No outstanding invoices. 🎉
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Invoice date</th>
            <th>Reference</th>
            <th class="num">Amount</th>
            <th class="num">Age</th>
            <th class="action"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in data.entries" :key="e.id" :class="{ paid: paidIds.has(e.id) }">
            <td>{{ e.vendor }}</td>
            <td class="mono">{{ e.date }}</td>
            <td class="mono ref">{{ e.reference_number || "—" }}</td>
            <td class="num mono">{{ fmt(e.amount, e.currency) }}</td>
            <td class="num mono" :class="ageClass(e.days_outstanding)">
              {{ e.days_outstanding != null ? `${e.days_outstanding}d` : "—" }}
            </td>
            <td class="action">
              <span v-if="paidIds.has(e.id)" class="paid-pill">✓ Paid</span>
              <button v-else class="ghost" @click="recordPaymentClick(e)">
                Record payment
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.awaiting-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.summary {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.summary .total {
  font-family: var(--font-mono);
  font-size: 1.4rem;
  font-weight: 600;
}

.summary .meta {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.empty {
  color: var(--text-muted);
  font-size: 0.85rem;
  padding: 0.5rem 0;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

th {
  text-align: left;
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0.35rem 0.5rem 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

td {
  padding: 0.4rem 0.5rem 0.4rem 0;
  border-bottom: 1px solid #efefea;
  vertical-align: middle;
}

tr.paid td {
  opacity: 0.55;
}

.num {
  text-align: right;
}

.action {
  text-align: right;
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
}

.ref {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.age-overdue {
  color: var(--danger);
  font-weight: 600;
}

.age-late {
  color: var(--warn);
}

.age-fresh {
  color: var(--text-muted);
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover {
  background: #f5f5f0;
}

.paid-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--ok);
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
}
</style>
