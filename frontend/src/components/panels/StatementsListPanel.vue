<script setup>
import { ref, inject } from "vue";
import { downloadFile } from "../../api.js";

const props = defineProps({
  data: { type: Object, required: true },
});

const token = inject("apiToken");
const downloading = ref(new Set());
const error = ref(null);

async function downloadStatement(entry) {
  if (!entry.download_path) return;
  error.value = null;
  const next = new Set(downloading.value);
  next.add(entry.id);
  downloading.value = next;
  try {
    const filename = entry.original_filename || `${entry.id}.pdf`;
    await downloadFile(token.value, entry.download_path, filename);
  } catch (e) {
    error.value = `Download failed: ${e.message}`;
  } finally {
    const after = new Set(downloading.value);
    after.delete(entry.id);
    downloading.value = after;
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

function fmtShort(amount, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function shortDate(iso) {
  return iso ? iso.slice(0, 10) : "—";
}

function statusClass(status) {
  return `status-${status}`;
}
</script>

<template>
  <div class="stmt-list-panel">
    <div class="summary">
      <span class="total">{{ data.count }}</span>
      <span class="meta">
        statement<span v-if="data.count !== 1">s</span>
        <template v-if="data.status_filter !== 'all'"> · filtered to {{ data.status_filter }}</template>
      </span>
      <div v-if="Object.keys(data.counts).length > 1" class="status-counts">
        <span
          v-for="(n, status) in data.counts"
          :key="status"
          class="count-chip"
          :class="statusClass(status)"
        >
          {{ n }} {{ status.replace(/_/g, ' ') }}
        </span>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="data.entries.length === 0" class="empty">
      No statements imported yet. Use the upload zone with the
      <em>Bank / card statement</em> tab selected.
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Statement date</th>
            <th>Source</th>
            <th>Period</th>
            <th class="num">Lines</th>
            <th class="num">Opening</th>
            <th class="num">Closing</th>
            <th class="num">Charges</th>
            <th class="num">Payments</th>
            <th>Status</th>
            <th class="action"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in data.entries" :key="e.id">
            <td class="mono">{{ shortDate(e.statement_date) }}</td>
            <td class="src">{{ e.source }}</td>
            <td class="mono period">
              {{ shortDate(e.period_start) }} → {{ shortDate(e.period_end) }}
            </td>
            <td class="num mono">{{ e.line_count }}</td>
            <td class="num mono">{{ fmtShort(e.opening_balance, e.currency) }}</td>
            <td class="num mono">{{ fmtShort(e.closing_balance, e.currency) }}</td>
            <td class="num mono">{{ fmtShort(e.total_charges, e.currency) }}</td>
            <td class="num mono">{{ fmtShort(e.total_payments, e.currency) }}</td>
            <td>
              <span class="pill" :class="statusClass(e.status)">
                {{ e.status.replace(/_/g, ' ') }}
              </span>
            </td>
            <td class="action">
              <button
                v-if="e.download_path"
                class="ghost"
                :disabled="downloading.has(e.id)"
                :title="`Download ${e.original_filename || 'statement.pdf'}`"
                @click="downloadStatement(e)"
              >
                {{ downloading.has(e.id) ? '…' : '⬇' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.stmt-list-panel {
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

.status-counts {
  display: flex;
  gap: 0.35rem;
  margin-left: auto;
}

.count-chip {
  font-size: 0.7rem;
  font-family: var(--font-mono);
  padding: 1px 6px;
  border-radius: 3px;
  background: #f0f0eb;
  color: var(--text-muted);
}

.error {
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.4rem 0.6rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: var(--radius);
}

.empty {
  color: var(--text-muted);
  font-size: 0.85rem;
  padding: 0.5rem 0;
}

.empty em {
  font-style: normal;
  background: #f0f0eb;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: var(--font-mono);
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}

th {
  text-align: left;
  font-weight: 600;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0.35rem 0.55rem 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

td {
  padding: 0.4rem 0.55rem 0.4rem 0;
  border-bottom: 1px solid #efefea;
  vertical-align: middle;
}

tr:hover td {
  background: #fafaf5;
}

.num {
  text-align: right;
}

.action {
  width: 38px;
  text-align: right;
}

.mono {
  font-family: var(--font-mono);
}

.src {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.period {
  white-space: nowrap;
}

.pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-family: var(--font-mono);
}

.pill.status-imported {
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
}

.pill.status-reconciled {
  background: #f0fdf4;
  color: var(--ok);
  border: 1px solid #bbf7d0;
}

.pill.status-partially_reconciled {
  background: #fffbeb;
  color: #b45309;
  border: 1px solid #fde68a;
}

.pill.status-needs_attention {
  background: #fef2f2;
  color: var(--danger);
  border: 1px solid #fecaca;
}

button.ghost {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  font-size: 1rem;
  line-height: 1;
  padding: 0.2rem 0.45rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover:not(:disabled) {
  background: #f5f5f0;
  color: var(--text);
}

button.ghost:disabled {
  opacity: 0.5;
  cursor: progress;
}
</style>
