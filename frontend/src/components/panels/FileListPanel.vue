<script setup>
import { ref, computed, inject } from "vue";
import { downloadFile } from "../../api.js";

const props = defineProps({
  data: { type: Object, required: true },
});

const token = inject("apiToken");

const selected = ref(new Set());
const busy = ref(false);
const error = ref(null);

const allSelected = computed(
  () =>
    props.data.files.length > 0 && selected.value.size === props.data.files.length,
);

function toggle(id) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll() {
  if (allSelected.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(props.data.files.map((f) => f.id));
  }
}

async function downloadOne(file) {
  error.value = null;
  try {
    await downloadFile(token.value, file.download_path, file.download_filename);
  } catch (err) {
    error.value = `Download failed: ${file.filename} — ${err.message}`;
  }
}

async function downloadSelected() {
  if (busy.value || selected.value.size === 0) return;
  busy.value = true;
  error.value = null;
  const files = props.data.files.filter((f) => selected.value.has(f.id));
  for (const f of files) {
    try {
      await downloadFile(token.value, f.download_path, f.download_filename);
      // Small gap so the browser actually queues each download separately
      // rather than batching them invisibly.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (err) {
      error.value = `Download failed: ${f.filename} — ${err.message}`;
      break;
    }
  }
  busy.value = false;
}

function shortDate(d) {
  return d ? d.slice(0, 10) : "—";
}

function kindLabel(k) {
  return k ? k.replace(/_/g, " ") : "—";
}
</script>

<template>
  <div class="file-list-panel">
    <div class="summary">
      <span class="total">{{ data.count }}</span>
      <span class="meta">
        file<span v-if="data.count !== 1">s</span>
        <template v-if="data.kind_filter !== 'all' && data.kind_filter">
          · filtered to {{ data.kind_filter }}
        </template>
        <template v-if="data.truncated"> · capped to 100 most recent</template>
      </span>
      <div class="actions">
        <button
          class="primary"
          :disabled="selected.size === 0 || busy"
          @click="downloadSelected"
        >
          {{ busy ? "Downloading…" : `Download ${selected.size || ""}`.trim() }}
        </button>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="data.files.length === 0" class="empty">
      No matching files.
    </div>
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="check">
              <input
                type="checkbox"
                :checked="allSelected"
                @change="toggleAll"
                title="Select all"
              />
            </th>
            <th>Date</th>
            <th>Vendor</th>
            <th>Kind</th>
            <th>Reference</th>
            <th>Filename</th>
            <th class="action"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="f in data.files"
            :key="f.id"
            :class="{ selected: selected.has(f.id), ledger: f.kind === 'ledger' }"
          >
            <td class="check">
              <input
                type="checkbox"
                :checked="selected.has(f.id)"
                @change="toggle(f.id)"
              />
            </td>
            <td class="mono muted">{{ shortDate(f.date) }}</td>
            <td>
              <template v-if="f.kind === 'ledger'"><em>Workbook</em></template>
              <template v-else>{{ f.vendor || "—" }}</template>
            </td>
            <td>
              <span class="kind-pill" :class="`kind-${f.kind}`">{{ kindLabel(f.kind) }}</span>
            </td>
            <td class="mono ref">{{ f.reference_number || "—" }}</td>
            <td class="mono filename" :title="f.filename">{{ f.filename }}</td>
            <td class="action">
              <button class="ghost" @click="downloadOne(f)" title="Download">⬇</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.file-list-panel {
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

.actions {
  margin-left: auto;
  display: flex;
  gap: 0.4rem;
}

.actions button.primary {
  padding: 0.3rem 0.7rem;
  font-size: 0.8rem;
}

.error {
  color: var(--danger);
  font-size: 0.8rem;
  margin: 0;
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

tr.selected td {
  background: #eff6ff;
}

tr.ledger td {
  background: #fffbeb;
}

tr.ledger.selected td {
  background: #fef3c7;
}

tr:hover td {
  background: #fafaf5;
}

tr.ledger:hover td {
  background: #fef3c7;
}

.check {
  width: 32px;
}

.check input {
  cursor: pointer;
}

.action {
  width: 36px;
  text-align: right;
}

.mono {
  font-family: var(--font-mono);
}

.muted {
  color: var(--text-muted);
}

.filename {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: capitalize;
  letter-spacing: 0.02em;
  font-family: var(--font-mono);
  background: #f0f0eb;
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.kind-invoice {
  background: #eff6ff;
  color: #1d4ed8;
  border-color: #bfdbfe;
}

.kind-receipt {
  background: #f0fdf4;
  color: #15803d;
  border-color: #bbf7d0;
}

.kind-ledger {
  background: #fffbeb;
  color: #b45309;
  border-color: #fde68a;
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

button.ghost:hover {
  background: #f5f5f0;
  color: var(--text);
}
</style>
