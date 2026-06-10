<script setup>
defineProps({
  data: { type: Object, required: true },
});

function fmt(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function activeFilters(f) {
  return [
    f.from || f.to ? `${f.from ?? "…"} – ${f.to ?? "…"}` : null,
    f.category ? `category: ${f.category}` : null,
    f.payment_source ? `source: ${f.payment_source}` : null,
    f.vendor ? `vendor: ${f.vendor}` : null,
  ].filter(Boolean);
}
</script>

<template>
  <div class="txn-table-panel">
    <div class="summary">
      <span class="total">{{ fmt(data.total_amount) }}</span>
      <span class="meta">
        {{ data.count }} txn<span v-if="data.count !== 1">s</span>
        <template v-if="data.truncated"> · showing first {{ data.shown }}</template>
      </span>
      <div class="filters">
        <span
          v-for="(f, i) in activeFilters(data.filters)"
          :key="i"
          class="filter-chip"
        >{{ f }}</span>
      </div>
    </div>

    <div v-if="data.transactions.length === 0" class="empty">
      No transactions match these filters.
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Vendor</th>
            <th>Category</th>
            <th>Source</th>
            <th class="num">Amount</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in data.transactions" :key="t.id">
            <td class="mono">{{ t.date }}</td>
            <td>{{ t.vendor }}</td>
            <td class="cat">{{ t.category }}</td>
            <td class="muted">{{ t.payment_source || "—" }}</td>
            <td class="num mono">{{ fmt(t.amount, t.currency) }}</td>
            <td class="mono ref">{{ t.reference_number || "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.txn-table-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.summary .total {
  font-family: var(--font-mono);
  font-size: 1.3rem;
  font-weight: 600;
}

.summary .meta {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-left: auto;
}

.filter-chip {
  background: #f0f0eb;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 0.7rem;
  font-family: var(--font-mono);
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
  padding: 0.35rem 0.5rem 0.35rem 0;
  border-bottom: 1px solid #efefea;
  vertical-align: top;
}

tr:hover td {
  background: #fafaf5;
}

.num {
  text-align: right;
}

.mono {
  font-family: var(--font-mono);
}

.muted {
  color: var(--text-muted);
}

.cat {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.ref {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
