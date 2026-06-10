<script setup>
import { ref, computed } from "vue";
import { uploadReceipt, uploadStatement } from "../api.js";

const props = defineProps({ token: { type: String, required: true } });
const emit = defineEmits(["uploaded"]);

const kind = ref("receipt"); // "receipt" | "statement"
const isStatement = computed(() => kind.value === "statement");
const descPlaceholder = computed(() =>
  isStatement.value
    ? "optional context (account nickname)"
    : "optional context (e.g. lunch with X)",
);

const SUPPORTED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
// 20 MB — generous for raw phone photos. Backend compresses oversized
// images (>~4.5MB) before sending to Anthropic's 5 MiB-limited vision API.
const MAX_BYTES = 20 * 1024 * 1024;

const dragOver = ref(false);
const file = ref(null);
const description = ref("");
const uploading = ref(false);
const error = ref(null);
const lastResult = ref(null);
const fileInput = ref(null);

function onDragOver(e) {
  e.preventDefault();
  dragOver.value = true;
}

function onDragLeave() {
  dragOver.value = false;
}

function onDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) selectFile(f);
}

function onPickClick() {
  fileInput.value?.click();
}

function onPickChange(e) {
  const f = e.target.files?.[0];
  if (f) selectFile(f);
  e.target.value = ""; // allow re-picking the same file
}

function selectFile(f) {
  error.value = null;
  lastResult.value = null;
  if (!SUPPORTED_TYPES.includes(f.type)) {
    error.value = `Unsupported type: ${f.type || "(unknown)"}. PDF or image only.`;
    return;
  }
  if (f.size > MAX_BYTES) {
    error.value = `Too large: ${formatSize(f.size)}. Max ${formatSize(MAX_BYTES)}.`;
    return;
  }
  file.value = f;
}

function clearFile() {
  file.value = null;
  description.value = "";
  error.value = null;
}

async function upload() {
  if (!file.value) return;
  uploading.value = true;
  error.value = null;
  lastResult.value = null;
  try {
    const payload = {
      file: file.value,
      description: description.value,
    };
    const res = isStatement.value
      ? await uploadStatement(props.token, payload)
      : await uploadReceipt(props.token, payload);
    lastResult.value = { ...res, _kind: kind.value };
    file.value = null;
    description.value = "";
    emit("uploaded", res);
  } catch (e) {
    error.value = e.message;
  } finally {
    uploading.value = false;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="upload-card">
    <div class="kind-toggle" role="tablist" aria-label="Upload kind">
      <button
        type="button"
        role="tab"
        :aria-selected="kind === 'receipt'"
        :class="{ active: kind === 'receipt' }"
        :disabled="uploading"
        @click="kind = 'receipt'"
      >Receipt / invoice</button>
      <button
        type="button"
        role="tab"
        :aria-selected="kind === 'statement'"
        :class="{ active: kind === 'statement' }"
        :disabled="uploading"
        @click="kind = 'statement'"
      >Bank / card statement</button>
    </div>

    <div
      class="drop-zone"
      :class="{ active: dragOver, busy: uploading, 'has-file': file }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="!file && !uploading && onPickClick()"
    >
      <input
        ref="fileInput"
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/gif"
        @change="onPickChange"
        hidden
      />

      <div v-if="uploading" class="state">
        <p class="primary">
          {{ isStatement ? "Parsing statement…" : "Parsing receipt…" }}
        </p>
        <p class="hint">
          {{ isStatement ? "Multi-page statements take 20–60 seconds." : "~5 seconds for the vision call" }}
        </p>
      </div>

      <div v-else-if="!file" class="state">
        <p class="primary">
          {{ isStatement ? "Drop a bank/card statement PDF here or click to pick" : "Drop a receipt here or click to pick" }}
        </p>
        <div v-if="!isStatement" class="or-email">
          <span class="or-sep">– or –</span>
          <span>
            email a receipt to
            <a
              class="email"
              href="mailto:receipts@demo.noviustec.com"
              @click.stop
            >receipts@demo.noviustec.com</a>
          </span>
        </div>
        <p class="hint">PDF or image (JPEG, PNG, WEBP, GIF) up to 20 MB. Large photos are compressed automatically.</p>
      </div>

      <div v-else class="state selected">
        <p class="filename">{{ file.name }}</p>
        <p class="meta">{{ file.type }} · {{ formatSize(file.size) }}</p>
        <div class="actions" @click.stop>
          <input v-model="description" :placeholder="descPlaceholder" />
          <button @click="clearFile">Remove</button>
          <button @click="upload" class="primary">Upload &amp; parse</button>
        </div>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <p v-if="lastResult && lastResult._kind !== 'statement'" class="success">
      Uploaded — parser returned
      <strong>{{ lastResult.status }}</strong
      ><span v-if="lastResult.reason"> ({{ lastResult.reason }})</span
      ><span v-if="lastResult.proposal?.vendor?.name">
        · {{ lastResult.proposal.vendor.name }}</span
      ><span v-if="lastResult.proposal?.total">
        · {{ lastResult.proposal.total.amount }}
        {{ lastResult.proposal.total.currency }}</span
      >
    </p>

    <p
      v-else-if="lastResult && lastResult._kind === 'statement' && lastResult.statement_id"
      class="success"
    >
      Statement imported —
      <strong>{{ lastResult.line_count }}</strong> line<span v-if="lastResult.line_count !== 1">s</span><span v-if="lastResult.source">
        · {{ lastResult.source }}</span
      ><span v-if="lastResult.period?.start && lastResult.period?.end">
        · {{ lastResult.period.start }} → {{ lastResult.period.end }}</span
      ><span v-if="lastResult.validation?.balance_check === 'mismatch'" class="warn">
        · ⚠ balance check off by {{ lastResult.validation.balance_check_diff }}</span
      >
    </p>

    <p
      v-else-if="lastResult && lastResult._kind === 'statement'"
      class="error"
    >
      Statement not imported — parser returned
      <strong>{{ lastResult.status }}</strong
      ><span v-if="lastResult.reason"> ({{ lastResult.reason }})</span>. Try a
      different page range or check that the file is a full statement, not a
      single transaction.
    </p>
  </div>
</template>

<style scoped>
.upload-card {
  margin-bottom: 1.5rem;
}

.kind-toggle {
  display: inline-flex;
  gap: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2px;
  margin-bottom: 0.5rem;
}

.kind-toggle button {
  background: transparent;
  border: none;
  font-size: 0.78rem;
  padding: 0.3rem 0.7rem;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
}

.kind-toggle button:hover:not(:disabled):not(.active) {
  background: #f5f5f0;
  color: var(--text);
}

.kind-toggle button.active {
  background: var(--accent);
  color: white;
  font-weight: 600;
}

.kind-toggle button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.warn {
  color: var(--warn);
  font-weight: 600;
}

.drop-zone {
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
  background: var(--surface);
  text-align: center;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.drop-zone:hover:not(.has-file):not(.busy) {
  border-color: var(--accent);
}

.drop-zone.active {
  border-color: var(--accent);
  background: #eff6ff;
}

.drop-zone.has-file {
  cursor: default;
  text-align: left;
  border-style: solid;
}

.drop-zone.busy {
  cursor: progress;
  opacity: 0.75;
}

.state .primary {
  margin: 0;
  font-weight: 500;
}

.state .hint {
  margin: 0.25rem 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

.or-email {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  margin: 0.5rem 0 0.85rem;
  font-size: 13px;
  color: var(--text-muted);
}

.or-email .or-sep {
  letter-spacing: 0.05em;
}

.or-email .email {
  color: var(--text);
  font-weight: 500;
  text-decoration: underline;
}

.selected .filename {
  margin: 0;
  font-weight: 600;
}

.selected .meta {
  margin: 0.25rem 0 0.75rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 12px;
}

.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.actions input {
  flex: 1;
}

.error {
  background: #fef2f2;
  color: var(--danger);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius);
  border: 1px solid #fca5a5;
  margin: 0.75rem 0 0;
  font-size: 13px;
}

.success {
  background: #f0fdf4;
  color: var(--ok);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius);
  border: 1px solid #86efac;
  margin: 0.75rem 0 0;
  font-size: 13px;
}
</style>
