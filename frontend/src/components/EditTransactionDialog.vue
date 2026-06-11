<script setup>
import { ref, onMounted, onBeforeUnmount, inject } from "vue";
import {
  fetchTransaction,
  updateTransaction,
  deleteTransaction,
  getCategories,
  getPaymentSources,
  downloadTransactionDocument,
} from "../api.js";

const props = defineProps({
  txnId: { type: String, required: true },
});
const emit = defineEmits(["success", "cancel"]);

const token = inject("apiToken");

// Comprehensive list of every reference_kind value any flow can write,
// so a row loaded for editing can find its existing value in the
// dropdown. The PATCH endpoint accepts any string (the enum was
// relaxed because every new write path that introduced a kind broke
// editing). Keep this list in sync as new kinds appear.
const REFERENCE_KINDS = [
  { value: "", label: "(none)" },
  { value: "invoice", label: "Invoice" },
  { value: "receipt", label: "Receipt" },
  { value: "order", label: "Order" },
  { value: "statement", label: "Statement (reconciliation)" },
  { value: "check", label: "Check" },
  { value: "card", label: "Credit card" },
  { value: "ach", label: "ACH" },
  { value: "wire", label: "Wire" },
  { value: "cash", label: "Cash" },
  { value: "transaction", label: "Transaction (generic)" },
  { value: "confirmation", label: "Confirmation" },
  { value: "other", label: "Other" },
];

const loading = ref(true);
const submitting = ref(false);
const deleting = ref(false);
const confirmingDelete = ref(false);
const error = ref(null);
const blockers = ref(null);
const form = ref(null);
const original = ref(null);
const categories = ref([]);
const paymentSources = ref([]);

async function load() {
  try {
    const [row, cats, srcs] = await Promise.all([
      fetchTransaction(token.value, props.txnId),
      getCategories(token.value),
      getPaymentSources(token.value),
    ]);
    original.value = row;
    categories.value = cats.categories ?? [];
    paymentSources.value = srcs.sources ?? [];
    form.value = {
      vendor: row.vendor ?? "",
      date: toDateInput(row.date),
      amount: row.amount ?? 0,
      currency: row.currency ?? "USD",
      category: row.category ?? "",
      payment_source: row.payment_source ?? "",
      reference_number: row.reference_number ?? "",
      reference_kind: row.reference_kind ?? "",
      description: row.description ?? "",
      notes: row.notes ?? "",
    };
  } catch (e) {
    error.value = e.message || "Failed to load transaction.";
  } finally {
    loading.value = false;
  }
}

function toDateInput(v) {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return "";
}

const downloading = ref(false);
async function downloadDoc() {
  downloading.value = true;
  error.value = null;
  try {
    await downloadTransactionDocument(token.value, props.txnId);
  } catch (e) {
    error.value = e.message || "Couldn't download the file.";
  } finally {
    downloading.value = false;
  }
}

function onKeyDown(e) {
  if (e.key === "Escape" && !submitting.value) emit("cancel");
}

onMounted(() => {
  window.addEventListener("keydown", onKeyDown);
  document.body.style.overflow = "hidden";
  load();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  document.body.style.overflow = "";
});

async function save() {
  if (!form.value) return;
  if (!form.value.vendor?.trim()) {
    error.value = "Vendor is required.";
    return;
  }
  if (!form.value.date) {
    error.value = "Date is required.";
    return;
  }
  if (!Number.isFinite(Number(form.value.amount))) {
    error.value = "Amount must be a number.";
    return;
  }
  if (!form.value.category?.trim()) {
    error.value = "Category is required.";
    return;
  }

  submitting.value = true;
  error.value = null;
  try {
    await updateTransaction(token.value, props.txnId, {
      vendor: form.value.vendor.trim(),
      date: form.value.date,
      amount: Number(form.value.amount),
      currency: form.value.currency || "USD",
      category: form.value.category,
      payment_source: form.value.payment_source || null,
      reference_number: form.value.reference_number?.trim() || null,
      reference_kind: form.value.reference_kind || null,
      description: form.value.description ?? "",
      notes: form.value.notes ?? "",
    });
    emit("success");
  } catch (e) {
    error.value = e.message || "Save failed.";
  } finally {
    submitting.value = false;
  }
}

async function doDelete() {
  error.value = null;
  blockers.value = null;
  deleting.value = true;
  try {
    await deleteTransaction(token.value, props.txnId);
    emit("success");
  } catch (e) {
    // Surface the server's blocker list verbatim when present (409
    // Conflict). Falls through to a generic message otherwise.
    if (e?.data?.blockers && Array.isArray(e.data.blockers)) {
      blockers.value = e.data.blockers;
      error.value = e.data.error || "Cannot delete.";
    } else {
      error.value = e.message || "Delete failed.";
    }
    confirmingDelete.value = false;
  } finally {
    deleting.value = false;
  }
}

function fmtAmount(n, currency = "USD") {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(n);
}
</script>

<template>
  <div class="ed-backdrop" @click.self="!submitting && emit('cancel')">
    <div class="ed-card" role="dialog" aria-modal="true">
      <header class="ed-head">
        <div>
          <span class="ed-kicker">Edit transaction</span>
          <h3 class="ed-title">
            {{ original?.vendor || "…" }}
            <span v-if="original" class="ed-amount-pill">
              {{ fmtAmount(original.amount, original.currency) }}
            </span>
          </h3>
          <p class="ed-sub mono">{{ txnId }}</p>
        </div>
        <div class="ed-head-actions">
          <button
            v-if="original?.document_path"
            class="ed-download"
            type="button"
            :disabled="downloading"
            title="Download the attached file"
            @click="downloadDoc"
          >⬇ {{ downloading ? "…" : "File" }}</button>
          <button class="ed-close" :disabled="submitting" @click="emit('cancel')" aria-label="Close">×</button>
        </div>
      </header>

      <div v-if="loading" class="ed-loading">Loading…</div>

      <form v-else-if="form" class="ed-form" @submit.prevent="save">
        <div class="ed-grid">
          <label>
            <span>Vendor</span>
            <input type="text" v-model="form.vendor" required />
          </label>
          <label>
            <span>Date</span>
            <input type="date" v-model="form.date" required />
          </label>
          <label>
            <span>Amount</span>
            <input type="number" step="0.01" v-model.number="form.amount" required />
          </label>
          <label>
            <span>Currency</span>
            <input type="text" v-model="form.currency" maxlength="3" />
          </label>
          <label>
            <span>Category</span>
            <select v-model="form.category" required>
              <option value="" disabled>Pick one</option>
              <option v-for="c in categories" :key="c.name" :value="c.name">
                {{ c.name }}
              </option>
            </select>
          </label>
          <label>
            <span>Payment source</span>
            <input
              type="text"
              list="ed-payment-sources"
              v-model="form.payment_source"
              placeholder="Card / bank / cash"
            />
            <datalist id="ed-payment-sources">
              <option v-for="s in paymentSources" :key="s.name" :value="s.name">
                {{ s.last4 ? `${s.name} · ••${s.last4}` : s.name }}
              </option>
            </datalist>
          </label>
          <label>
            <span>Reference number</span>
            <input
              type="text"
              v-model="form.reference_number"
              placeholder="check # / confirmation / ref"
            />
          </label>
          <label>
            <span>Reference type</span>
            <select v-model="form.reference_kind">
              <option v-for="k in REFERENCE_KINDS" :key="k.value" :value="k.value">
                {{ k.label }}
              </option>
            </select>
          </label>
        </div>

        <label class="ed-row">
          <span>Description</span>
          <input type="text" v-model="form.description" />
        </label>
        <label class="ed-row">
          <span>Notes</span>
          <input type="text" v-model="form.notes" />
        </label>

        <p v-if="error" class="ed-error">{{ error }}</p>
        <ul v-if="blockers && blockers.length > 0" class="ed-blockers">
          <li v-for="(b, i) in blockers" :key="i">{{ b }}</li>
        </ul>

        <div class="ed-actions">
          <button
            type="button"
            class="danger ghost-danger"
            :disabled="submitting || deleting"
            @click="confirmingDelete = !confirmingDelete"
          >
            {{ confirmingDelete ? "Cancel delete" : "Delete" }}
          </button>
          <button
            v-if="confirmingDelete"
            type="button"
            class="danger"
            :disabled="deleting"
            @click="doDelete"
          >
            {{ deleting ? "Deleting…" : "Confirm delete" }}
          </button>
          <span class="ed-spacer" />
          <button type="button" class="ghost" :disabled="submitting || deleting" @click="emit('cancel')">
            Cancel
          </button>
          <button type="submit" class="primary" :disabled="submitting || deleting || confirmingDelete">
            {{ submitting ? "Saving…" : "Save changes" }}
          </button>
        </div>
      </form>

      <p v-else class="ed-error">{{ error || "Couldn't load transaction." }}</p>
    </div>
  </div>
</template>

<style scoped>
.ed-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 3rem 1rem 2rem;
  z-index: 1000;
  overflow-y: auto;
}

.ed-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(720px, 100%);
  padding: 1rem 1.1rem 1.1rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
}

.ed-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.85rem;
  padding-bottom: 0.65rem;
  border-bottom: 1px solid var(--border);
}

.ed-kicker {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  font-weight: 700;
  color: var(--text-muted);
}

.ed-title {
  margin: 0.1rem 0 0;
  font-size: 1.05rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.ed-amount-pill {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 600;
  background: #eff6ff;
  color: #1d4ed8;
  border: 1px solid #bfdbfe;
  padding: 1px 8px;
  border-radius: 10px;
}

.ed-sub {
  margin: 0.25rem 0 0;
  font-size: 0.7rem;
  color: var(--text-muted);
}

.ed-head-actions {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
}

.ed-download {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.8rem;
  line-height: 1.2;
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.ed-download:hover:not(:disabled) {
  background: #f0f0eb;
  color: var(--text);
  border-color: #d0d0c8;
}

.ed-download:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ed-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.5rem;
  line-height: 1;
  padding: 0 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}

.ed-close:hover:not(:disabled) {
  background: #f0f0eb;
  color: var(--text);
}

.ed-close:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ed-loading {
  padding: 1rem 0;
  color: var(--text-muted);
}

.ed-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.ed-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.55rem 0.65rem;
}

.ed-form label,
.ed-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.ed-form label span,
.ed-row span {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.65rem;
}

.ed-form input,
.ed-form select {
  font-size: 0.85rem;
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.mono {
  font-family: var(--font-mono);
}

.ed-error {
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.35rem 0.55rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
}

.ed-blockers {
  margin: 0;
  padding: 0.35rem 0.55rem 0.35rem 1.4rem;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 4px;
  font-size: 0.78rem;
  color: #92400e;
  line-height: 1.4;
}

.ed-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.4rem;
}

.ed-spacer {
  flex: 1 1 auto;
}

button.danger {
  background: var(--danger);
  border: 1px solid var(--danger);
  color: white;
  font-size: 0.8rem;
  padding: 0.35rem 0.85rem;
  border-radius: 4px;
  cursor: pointer;
}

button.danger.ghost-danger {
  background: transparent;
  color: var(--danger);
}

button.danger.ghost-danger:hover:not(:disabled) {
  background: #fef2f2;
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.8rem;
  padding: 0.3rem 0.7rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover:not(:disabled) {
  background: #f5f5f0;
}

button.primary {
  font-size: 0.8rem;
  padding: 0.35rem 0.85rem;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
