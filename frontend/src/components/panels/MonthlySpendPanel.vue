<script setup>
import { computed } from "vue";

const props = defineProps({
  data: { type: Object, required: true },
});

const max = computed(() => {
  const values = (props.data.months ?? []).map((m) => m.total);
  return Math.max(1, ...values);
});

function fmt(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function fmtFull(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortMonth(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`;
}

function fullMonth(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const long = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${long[m - 1]} ${y}`;
}

function pct(amount) {
  return Math.round((Math.max(0, amount) / max.value) * 100);
}

// Round-number gridline labels at 0/25/50/75/100% of the y-axis max.
const gridlines = computed(() => {
  const m = max.value;
  return [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(m * f));
});

const filtersDesc = computed(() => {
  const parts = [];
  if (props.data.filters?.vendor) {
    parts.push(`vendor: ${props.data.filters.vendor}`);
  }
  if (props.data.filters?.include?.length > 0) {
    parts.push(`only: ${props.data.filters.include.join(", ")}`);
  }
  if (props.data.filters?.exclude?.length > 0) {
    parts.push(`excluding: ${props.data.filters.exclude.join(", ")}`);
  }
  return parts.join(" · ");
});
</script>

<template>
  <div class="ms-root">
    <header class="ms-head">
      <div class="ms-summary">
        <span class="ms-total mono">{{ fmt(data.summary.total_spend) }}</span>
        <span class="ms-meta">
          across {{ data.summary.total_count }} transaction<span v-if="data.summary.total_count !== 1">s</span>
          · {{ data.period.from }} – {{ data.period.to }}
        </span>
      </div>
      <div class="ms-stats">
        <div class="ms-stat" v-if="data.summary.months_with_activity > 0">
          <span class="ms-stat-label">Avg / active month</span>
          <span class="ms-stat-value mono">{{ fmt(data.summary.average_per_active_month) }}</span>
        </div>
        <div class="ms-stat" v-if="data.summary.peak_month">
          <span class="ms-stat-label">Peak</span>
          <span class="ms-stat-value mono">
            {{ fmt(data.summary.peak_amount) }}
            <span class="ms-stat-sub">({{ shortMonth(data.summary.peak_month) }})</span>
          </span>
        </div>
      </div>
    </header>

    <p v-if="filtersDesc" class="ms-filter-line">{{ filtersDesc }}</p>

    <div v-if="data.months.length === 0" class="ms-empty">
      No months in range.
    </div>

    <div v-else class="ms-chart">
      <!-- Y-axis gridline labels -->
      <div class="ms-yaxis">
        <div
          v-for="(g, idx) in [...gridlines].reverse()"
          :key="idx"
          class="ms-ytick mono"
        >{{ fmt(g) }}</div>
      </div>

      <!-- Bars -->
      <div class="ms-plot">
        <!-- Horizontal gridlines positioned at quartile heights -->
        <div
          v-for="(g, idx) in [...gridlines].reverse()"
          :key="idx"
          class="ms-gridline"
          :style="{ top: (idx * 25) + '%' }"
        />
        <!-- Bar columns -->
        <div class="ms-bars">
          <div
            v-for="m in data.months"
            :key="m.month"
            class="ms-col"
            :title="`${fullMonth(m.month)} — ${fmtFull(m.total)} across ${m.count} txn`"
          >
            <span
              v-if="m.total > 0"
              class="ms-bar-amount mono"
            >{{ fmt(m.total) }}</span>
            <div class="ms-bar-track">
              <div
                class="ms-bar"
                :style="{ height: pct(m.total) + '%' }"
              />
            </div>
            <span class="ms-bar-label">{{ shortMonth(m.month) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ms-root {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.ms-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.ms-summary {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.ms-total {
  font-size: 1.6rem;
  font-weight: 600;
  color: var(--text);
}

.ms-meta {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.ms-stats {
  display: flex;
  gap: 1.25rem;
}

.ms-stat {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.15rem;
}

.ms-stat-label {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  font-weight: 600;
}

.ms-stat-value {
  font-size: 0.95rem;
  font-weight: 600;
}

.ms-stat-sub {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-weight: 400;
  font-family: var(--font-sans, inherit);
  margin-left: 0.25rem;
}

.ms-filter-line {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
}

.ms-empty {
  color: var(--text-muted);
  font-size: 0.9rem;
  padding: 1rem 0;
}

/* ── Chart ───────────────────────────────────────────────────────── */
.ms-chart {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 0.5rem;
  height: 360px;
}

.ms-yaxis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding-bottom: 26px; /* match the label strip below the bars */
  text-align: right;
}

.ms-ytick {
  font-size: 0.65rem;
  color: var(--text-muted);
  line-height: 1;
}

.ms-plot {
  position: relative;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  padding-bottom: 26px; /* room for month labels */
}

.ms-gridline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed #e7e7e0;
  z-index: 0;
}

.ms-gridline:last-child {
  /* baseline gridline is the chart's bottom border itself */
  border-top: none;
}

.ms-bars {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: space-around;
  height: 100%;
  padding: 0 4px;
  z-index: 1;
  gap: 4px;
}

.ms-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  position: relative;
}

.ms-bar-amount {
  position: absolute;
  top: -16px;
  font-size: 0.62rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.ms-bar-track {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.ms-bar {
  width: 70%;
  max-width: 60px;
  background: var(--accent);
  border-radius: 2px 2px 0 0;
  transition: height 0.3s ease-out;
  min-height: 1px;
}

.ms-col:hover .ms-bar {
  filter: brightness(0.85);
}

.ms-bar-label {
  position: absolute;
  bottom: -22px;
  font-size: 0.68rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono);
}

@media (max-width: 720px) {
  .ms-chart {
    grid-template-columns: 56px 1fr;
    height: 280px;
  }
  .ms-bar-amount {
    display: none;
  }
}
</style>
