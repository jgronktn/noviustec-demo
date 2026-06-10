<script setup>
import { computed } from "vue";

const props = defineProps({
  data: { type: Object, required: true },
});

const max = computed(() => {
  const values = props.data.vendors?.map((v) => v.total) ?? [];
  return Math.max(1, ...values);
});

function fmt(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function pct(amount) {
  return (Math.max(0, amount) / max.value) * 100;
}

function rangeLabel(period) {
  if (period.from && period.to) return `${period.from} – ${period.to}`;
  if (period.from) return `from ${period.from}`;
  if (period.to) return `through ${period.to}`;
  return "all time";
}
</script>

<template>
  <div class="vendor-breakdown">
    <div class="summary">
      <span class="total">{{ fmt(data.total_expense) }}</span>
      <span class="meta">
        across {{ data.total_count }} transaction<span v-if="data.total_count !== 1">s</span> ·
        {{ data.count }} vendor<span v-if="data.count !== 1">s</span>
        <template v-if="data.truncated"> · top {{ data.count }} shown</template>
        · {{ rangeLabel(data.period) }}
      </span>
      <span v-if="data.category" class="filter-chip">category: {{ data.category }}</span>
    </div>
    <div v-if="data.vendors.length === 0" class="empty">
      No transactions in this range.
    </div>
    <ul v-else class="bars">
      <li v-for="row in data.vendors" :key="row.vendor" class="bar-row">
        <span class="vendor">{{ row.vendor }}</span>
        <span class="bar-wrap">
          <span class="bar" :style="{ width: pct(row.total) + '%' }" />
        </span>
        <span class="amount">{{ fmt(row.total) }}</span>
        <span class="count">{{ row.count }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.vendor-breakdown {
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
  font-size: 1.6rem;
  font-weight: 600;
  color: var(--text);
}

.summary .meta {
  font-size: 0.8rem;
  color: var(--text-muted);
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

.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.bar-row {
  display: grid;
  grid-template-columns: 220px 1fr 100px 40px;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
}

.vendor {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar-wrap {
  background: #f0f0eb;
  height: 14px;
  border-radius: 2px;
  overflow: hidden;
}

.bar {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.3s ease-out;
}

.amount {
  font-family: var(--font-mono);
  text-align: right;
  color: var(--text);
}

.count {
  font-family: var(--font-mono);
  text-align: right;
  color: var(--text-muted);
  font-size: 0.7rem;
}

@media (max-width: 700px) {
  .bar-row {
    grid-template-columns: 120px 1fr 80px 30px;
    font-size: 0.75rem;
  }
}
</style>
