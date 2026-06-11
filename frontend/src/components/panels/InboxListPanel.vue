<script setup>
import { ref, inject } from "vue";
import { downloadPendingDocument } from "../../api.js";

defineProps({
  data: { type: Object, required: true },
});

// Provided by App.vue so panels can make authenticated requests.
const token = inject("apiToken");
const downloadError = ref("");

// Email/upload entries have a saved source payload with the original file.
// "other" entries (inline-HTML emails, manual) have nothing to download.
function hasDocument(e) {
  return e.source_kind === "email" || e.source_kind === "upload";
}

async function download(e) {
  downloadError.value = "";
  try {
    await downloadPendingDocument(token.value, e.id);
  } catch (err) {
    downloadError.value = `Couldn't download ${e.vendor || "entry"}: ${err.message}`;
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

function shortDate(iso) {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function statusClass(status) {
  return `status-${status}`;
}

function sourceIcon(kind) {
  if (kind === "email") return "✉";
  if (kind === "upload") return "↑";
  return "•";
}
</script>

<template>
  <div class="inbox-list-panel">
    <div class="summary">
      <span class="total">{{ data.count }}</span>
      <span class="meta">
        item<span v-if="data.count !== 1">s</span>
        <template v-if="data.status_filter !== 'all'"> · filtered to {{ data.status_filter }}</template>
        <template v-if="data.truncated"> · showing first {{ data.shown }}</template>
      </span>
      <div v-if="data.status_filter === 'all'" class="status-counts">
        <span class="count-chip status-pending">{{ data.counts.pending }} pending</span>
        <span class="count-chip status-approved">{{ data.counts.approved }} approved</span>
        <span class="count-chip status-rejected">{{ data.counts.rejected }} rejected</span>
      </div>
    </div>

    <p v-if="downloadError" class="dl-error">{{ downloadError }}</p>

    <div v-if="data.entries.length === 0" class="empty">
      Nothing here yet.
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Src</th>
            <th>Vendor</th>
            <th>Doc date</th>
            <th class="num">Total</th>
            <th>Reference</th>
            <th>Status</th>
            <th class="dl-col">File</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in data.entries" :key="e.id">
            <td class="mono">{{ shortDate(e.received_at) }}</td>
            <td class="src" :title="e.source_kind">{{ sourceIcon(e.source_kind) }}</td>
            <td>{{ e.vendor || "—" }}</td>
            <td class="mono muted">{{ e.date || "—" }}</td>
            <td class="num mono">{{ fmt(e.total, e.currency) }}</td>
            <td class="mono ref">{{ e.reference_number || "—" }}</td>
            <td>
              <span class="pill" :class="statusClass(e.status)">{{ e.status }}</span>
            </td>
            <td class="dl-col">
              <button
                v-if="hasDocument(e)"
                class="dl-btn"
                title="Download original file"
                @click="download(e)"
              >⬇</button>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.inbox-list-panel {
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

.src {
  font-family: var(--font-mono);
  color: var(--text-muted);
  text-align: center;
  width: 24px;
}

.ref {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-error {
  color: var(--danger);
  font-size: 0.8rem;
  margin: 0;
}

.dl-col {
  text-align: center;
  width: 44px;
}

.dl-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 7px;
  font-size: 0.85rem;
  line-height: 1.2;
  color: var(--text-muted);
  cursor: pointer;
}

.dl-btn:hover {
  background: #f0f0eb;
  color: var(--text);
  border-color: #d0d0c8;
}

.pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-family: var(--font-mono);
}

.pill.status-pending {
  background: #fff7ed;
  color: var(--warn);
  border: 1px solid #fed7aa;
}

.pill.status-approved {
  background: #f0fdf4;
  color: var(--ok);
  border: 1px solid #bbf7d0;
}

.pill.status-rejected {
  background: #f3f4f6;
  color: var(--text-muted);
  border: 1px solid #e5e7eb;
}
</style>
