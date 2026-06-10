<script setup>
defineProps({
  data: { type: Object, required: true },
});

function fmt(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}
</script>

<template>
  <div class="kpi-summary">
    <div class="tile">
      <span class="label">Pending review</span>
      <span class="value">{{ data.pending_count }}</span>
      <span class="hint">in the inbox</span>
    </div>
    <div class="tile">
      <span class="label">YTD spend</span>
      <span class="value">{{ fmt(data.ytd_spend) }}</span>
      <span class="hint">{{ data.ytd_count }} transactions</span>
    </div>
    <div class="tile">
      <span class="label">Outstanding</span>
      <span class="value">{{ fmt(data.outstanding_total) }}</span>
      <span class="hint">{{ data.outstanding_count }} unpaid invoice<span v-if="data.outstanding_count !== 1">s</span></span>
    </div>
    <div class="tile">
      <span class="label">Last 30 days</span>
      <span class="value">{{ fmt(data.recent_30d_spend) }}</span>
      <span class="hint">{{ data.recent_30d_count }} txns</span>
    </div>
  </div>
</template>

<style scoped>
.kpi-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.85rem 1rem;
  background: #fafaf5;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  color: var(--text-muted);
}

.value {
  font-family: var(--font-mono);
  font-size: 1.55rem;
  font-weight: 600;
  color: var(--text);
}

.hint {
  font-size: 0.75rem;
  color: var(--text-muted);
}
</style>
