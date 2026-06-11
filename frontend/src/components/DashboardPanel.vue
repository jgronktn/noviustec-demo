<script setup>
import { ref, watch } from "vue";
import ReviewPanel from "./ReviewPanel.vue";
import PnlChartPanel from "./panels/PnlChartPanel.vue";
import MonthlySpendPanel from "./panels/MonthlySpendPanel.vue";
import TransactionTablePanel from "./panels/TransactionTablePanel.vue";
import AwaitingTablePanel from "./panels/AwaitingTablePanel.vue";
import KpiSummaryPanel from "./panels/KpiSummaryPanel.vue";
import VendorBreakdownPanel from "./panels/VendorBreakdownPanel.vue";
import InboxListPanel from "./panels/InboxListPanel.vue";
import FileListPanel from "./panels/FileListPanel.vue";
import VendorTimelinePanel from "./panels/VendorTimelinePanel.vue";
import StatementsListPanel from "./panels/StatementsListPanel.vue";
import ReconciliationPanel from "./panels/ReconciliationPanel.vue";
import TransactionDraftPanel from "./panels/TransactionDraftPanel.vue";
import CategoryManagerPanel from "./panels/CategoryManagerPanel.vue";

const props = defineProps({
  token: { type: String, required: true },
  selectedId: { type: String, default: null },
  panels: { type: Array, default: () => [] }, // [{id, kind, title, props}]
});
const emit = defineEmits(["close", "dismiss-panel", "clear-panels"]);

// Force-remount ReviewPanel when selectedId changes so its onMounted
// fetches the new pending entry's data instead of holding stale state.
const reviewKey = ref(0);
watch(
  () => props.selectedId,
  () => {
    reviewKey.value += 1;
  },
);

const KIND_TO_COMPONENT = {
  pnl_chart: PnlChartPanel,
  monthly_spend_chart: MonthlySpendPanel,
  transaction_table: TransactionTablePanel,
  awaiting_table: AwaitingTablePanel,
  kpi_summary: KpiSummaryPanel,
  vendor_breakdown: VendorBreakdownPanel,
  inbox_list: InboxListPanel,
  file_list: FileListPanel,
  vendor_timeline: VendorTimelinePanel,
  // Statement-only timeline reuses the same template — handler emits
  // events in vendor-timeline shape (card balances on the left,
  // bank statements on the right).
  statement_timeline: VendorTimelinePanel,
  // Deposit-only timeline reuses the same template — handler emits
  // events in vendor-timeline shape with empty left, income-only
  // right cards (green DEPOSIT styling).
  deposit_activity: VendorTimelinePanel,
  statements_list: StatementsListPanel,
  reconciliation: ReconciliationPanel,
  transaction_draft: TransactionDraftPanel,
  category_manager: CategoryManagerPanel,
};

function componentFor(kind) {
  return KIND_TO_COMPONENT[kind] ?? null;
}
</script>

<template>
  <!-- A selected inbox row takes the whole canvas. Agent panels stay parked
       in App-level state and reappear when the review closes. -->
  <ReviewPanel
    v-if="selectedId"
    :key="reviewKey"
    :token="token"
    :id="selectedId"
    @back="emit('close')"
  />

  <div v-else-if="panels.length > 0" class="panel-stack">
    <header class="stack-head">
      <span class="stack-title">Canvas</span>
      <button class="clear" @click="emit('clear-panels')">Clear all</button>
    </header>
    <div class="cards">
      <article
        v-for="panel in panels"
        :key="panel.id"
        class="card"
      >
        <header class="card-head">
          <span class="card-kind">{{ panel.kind.replace(/_/g, " ") }}</span>
          <h3 class="card-title">{{ panel.title }}</h3>
          <button
            class="dismiss"
            :title="'Dismiss ' + panel.title"
            @click="emit('dismiss-panel', panel.id)"
          >×</button>
        </header>
        <div class="card-body">
          <component
            v-if="componentFor(panel.kind)"
            :is="componentFor(panel.kind)"
            :data="panel.props"
          />
          <pre v-else class="unknown">Unknown panel kind: {{ panel.kind }}</pre>
        </div>
      </article>
    </div>
  </div>

  <div v-else class="empty">
    <div class="empty-card">
      <p class="title">Ask the agent for a view</p>
      <p class="hint">
        Try <em>"show YTD spend by category"</em> or <em>"state of the books"</em>.
        Pick an inbox row to review a pending receipt instead.
      </p>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 2rem;
}

.empty-card {
  text-align: center;
  max-width: 480px;
  color: var(--text-muted);
}

.empty-card .title {
  font-size: 1.05rem;
  font-weight: 500;
  color: var(--text);
  margin: 0 0 0.5rem;
}

.empty-card .hint {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
}

.empty-card em {
  font-style: normal;
  background: #f0f0eb;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 0.85rem;
}

.panel-stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
  min-height: 0;
}

.stack-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.stack-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  color: var(--text-muted);
}

.clear {
  background: transparent;
  border: none;
  font-size: 0.75rem;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  border-radius: 3px;
}

.clear:hover {
  background: #f0f0eb;
  color: var(--text);
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  background: #fafaf5;
}

.card-kind {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.card-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dismiss {
  background: transparent;
  border: none;
  font-size: 1.1rem;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 0.4rem;
  border-radius: 3px;
}

.dismiss:hover {
  background: #efefea;
  color: var(--text);
}

.card-body {
  padding: 0.85rem 1rem 1rem;
}

.unknown {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--danger);
}
</style>
