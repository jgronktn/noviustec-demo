<script setup>
import { ref, onMounted } from "vue";
import { listPending } from "../api.js";
import UploadCard from "./UploadCard.vue";

const props = defineProps({
  token: { type: String, required: true },
  selectedId: { type: String, default: null },
});
const emit = defineEmits(["open"]);

const status = ref("pending");
const entries = ref([]);
const loading = ref(true);
const error = ref(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await listPending(props.token, status.value);
    entries.value = data.entries;
  } catch (e) {
    error.value = e.status === 401 ? "Token rejected (401)" : e.message;
    if (e.status === 401) localStorage.removeItem("noviustec_token");
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

function formatTotal(amount, currency) {
  if (amount == null) return "—";
  return `${currency || ""} ${Number(amount).toFixed(2)}`.trim();
}

function confidenceClass(c) {
  if (c == null) return "";
  if (c >= 0.85) return "conf-high";
  if (c >= 0.5) return "conf-mid";
  return "conf-low";
}
</script>

<template>
  <section class="inbox">
    <header class="head">
      <h2>Inbox</h2>
      <div class="controls">
        <select v-model="status" @change="load">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <button @click="load" :disabled="loading" class="refresh">
          {{ loading ? "…" : "↻" }}
        </button>
      </div>
    </header>

    <div class="upload-wrap">
      <UploadCard :token="token" @uploaded="load" />
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="!loading && entries.length === 0 && !error" class="empty">
      No {{ status }} entries.
    </div>

    <ul v-if="entries.length > 0" class="entries">
      <li
        v-for="e in entries"
        :key="e.id"
        @click="emit('open', e.id)"
        :class="{
          resolved: e.status !== 'pending',
          selected: e.id === selectedId,
        }"
      >
        <div class="row1">
          <span class="vendor">{{ e.vendor || "(no vendor)" }}</span>
          <span class="total">{{ formatTotal(e.total, e.currency) }}</span>
        </div>
        <div class="row2">
          <span class="date">{{ formatDate(e.date) }}</span>
          <span class="cat" v-if="e.suggested_category">·</span>
          <span class="cat" v-if="e.suggested_category">
            {{ e.suggested_category }}
          </span>
          <span
            v-if="e.confidence != null"
            class="conf"
            :class="confidenceClass(e.confidence)"
          >
            {{ Math.round(e.confidence * 100) }}%
          </span>
          <span v-if="e.reason" class="reason">{{ e.reason }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.inbox {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0.75rem;
  box-sizing: border-box;
}

/* Header + upload zone stay pinned; only .entries scrolls. */
.head,
.upload-wrap,
.error {
  flex: 0 0 auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.upload-wrap {
  /* Cancels the bottom margin UploadCard ships with so the gap between
     it and the list stays tight in a sidebar context. */
  margin-bottom: 0;
}

h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.controls {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}

.controls select {
  width: auto;
  font-size: 0.75rem;
  padding: 0.2rem 0.35rem;
}

.controls button.refresh {
  font-size: 0.95rem;
  padding: 0.15rem 0.45rem;
  line-height: 1;
}

.error {
  background: #fef2f2;
  color: var(--danger);
  padding: 0.5rem 0.6rem;
  border-radius: var(--radius);
  border: 1px solid #fca5a5;
  font-size: 0.8rem;
  margin: 0 0 0.5rem;
}

.empty {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-muted);
  padding: 1.5rem 0.5rem;
  font-size: 0.85rem;
}

.entries {
  /* Take all remaining vertical space, scroll independently. */
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.entries li {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem 0.6rem;
  cursor: pointer;
  transition:
    background 0.1s ease,
    border-color 0.1s ease;
}

.entries li:hover {
  background: #f5f5f0;
  border-color: #d0d0c8;
}

.entries li.selected {
  background: #eff6ff;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.entries li.resolved {
  opacity: 0.55;
}

.row1 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}

.vendor {
  font-weight: 600;
  font-size: 0.85rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.total {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: 0.8rem;
  white-space: nowrap;
}

.row2 {
  display: flex;
  gap: 0.4rem;
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 0.2rem;
  flex-wrap: wrap;
  align-items: center;
}

.cat {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}

.conf {
  font-family: var(--font-mono);
}

.conf-high {
  color: var(--ok);
}

.conf-mid {
  color: var(--warn);
}

.conf-low {
  color: var(--danger);
}

.reason {
  color: var(--warn);
  font-style: italic;
  white-space: nowrap;
}
</style>
