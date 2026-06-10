<script setup>
import { ref, computed, onMounted, onBeforeUnmount, inject } from "vue";
import { fetchAwaiting, updateAwaiting } from "../api.js";

const props = defineProps({
  awaitingId: { type: String, required: true },
});
const emit = defineEmits(["success", "cancel"]);

const token = inject("apiToken");
// Optional: provided by App.vue when the Record-payment dialog is wired
// up. Falls back to a no-op if not present (component still renders).
const openPaymentDialog = inject("openPaymentDialog", null);

// Show the in-dialog Record-payment button only for unpaid rows.
// "overdue" is a computed timeline-only status; in the sheet, anything
// not-yet-paid is "awaiting".
const canPay = computed(
  () => openPaymentDialog && original.value?.status === "awaiting",
);

function toIsoDate(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

async function recordPayment() {
  // Discard any pending form edits and hand control to the payment dialog.
  // The user is paying the invoice, not editing it. The Record-payment
  // success handler in App.vue calls signalLedgerChange(), which refetches
  // every visible timeline so the row's status flips to paid on its own.
  if (!original.value || !openPaymentDialog) return;
  emit("cancel");
  // Fire-and-forget; App.vue owns the dialog lifecycle from here.
  openPaymentDialog({
    id: original.value.id,
    vendor: original.value.vendor,
    amount: original.value.amount,
    currency: original.value.currency,
    reference_number: original.value.reference_number,
    date: toIsoDate(original.value.date),
    payment_kind: original.value.payment_kind,
  });
}

const REFERENCE_KINDS = [
  { value: "", label: "(none)" },
  { value: "invoice", label: "Invoice" },
  { value: "receipt", label: "Receipt" },
  { value: "order", label: "Order" },
  { value: "transaction", label: "Check / Transaction" },
  { value: "confirmation", label: "Confirmation" },
  { value: "other", label: "Other" },
];

const loading = ref(true);
const submitting = ref(false);
const error = ref(null);
const form = ref(null);
const original = ref(null);

async function load() {
  try {
    const row = await fetchAwaiting(token.value, props.awaitingId);
    original.value = row;
    form.value = {
      vendor: row.vendor ?? "",
      date: toDateInput(row.date),
      amount: row.amount ?? 0,
      currency: row.currency ?? "USD",
      reference_number: row.reference_number ?? "",
      reference_kind: row.reference_kind ?? "",
      description: row.description ?? "",
      notes: row.notes ?? "",
    };
  } catch (e) {
    error.value = e.message || "Failed to load row.";
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
  submitting.value = true;
  error.value = null;
  try {
    await updateAwaiting(token.value, props.awaitingId, {
      vendor: form.value.vendor.trim(),
      date: form.value.date,
      amount: Number(form.value.amount),
      currency: form.value.currency || "USD",
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
          <span class="ed-kicker">Edit invoice / awaiting payment</span>
          <h3 class="ed-title">
            {{ original?.vendor || "…" }}
            <span v-if="original" class="ed-amount-pill">
              {{ fmtAmount(original.amount, original.currency) }}
            </span>
            <span v-if="original?.status === 'paid'" class="ed-status-pill paid">paid</span>
            <span v-else-if="original?.status === 'awaiting'" class="ed-status-pill awaiting">awaiting</span>
            <span v-else-if="original" class="ed-status-pill">{{ original.status }}</span>
          </h3>
          <p class="ed-sub mono">{{ awaitingId }}</p>
        </div>
        <button class="ed-close" :disabled="submitting" @click="emit('cancel')" aria-label="Close">×</button>
      </header>

      <p class="ed-hint">
        Status changes (mark paid, reject, write off) happen through the
        <em>Record payment</em> flow — not editable here.
      </p>

      <div v-if="loading" class="ed-loading">Loading…</div>

      <form v-else-if="form" class="ed-form" @submit.prevent="save">
        <div class="ed-grid">
          <label>
            <span>Vendor</span>
            <input type="text" v-model="form.vendor" required />
          </label>
          <label>
            <span>Invoice date</span>
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
            <span>Reference number</span>
            <input type="text" v-model="form.reference_number" placeholder="invoice # / ref" />
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

        <div class="ed-actions">
          <button
            v-if="canPay"
            type="button"
            class="ed-pay-cta"
            :disabled="submitting"
            @click="recordPayment"
            title="Open the Record-payment dialog for this invoice"
          >Record payment →</button>
          <button type="button" class="ghost" :disabled="submitting" @click="emit('cancel')">
            Cancel
          </button>
          <button type="submit" class="primary" :disabled="submitting">
            {{ submitting ? "Saving…" : "Save changes" }}
          </button>
        </div>
      </form>

      <p v-else class="ed-error">{{ error || "Couldn't load row." }}</p>
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
  margin-bottom: 0.5rem;
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
  gap: 0.5rem;
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

.ed-status-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-family: var(--font-mono);
  background: #f0f0eb;
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.ed-status-pill.paid {
  background: #f0fdf4;
  color: var(--ok);
  border-color: #bbf7d0;
}

.ed-status-pill.awaiting {
  background: #fffbeb;
  color: #b45309;
  border-color: #fde68a;
}

.ed-sub {
  margin: 0.25rem 0 0;
  font-size: 0.7rem;
  color: var(--text-muted);
}

.ed-pay-cta {
  background: var(--accent);
  color: white;
  border: 1px solid var(--accent);
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.35rem 0.85rem;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  /* Push the button to the lower-left while Cancel + Save stay right. */
  margin-right: auto;
}

.ed-pay-cta:hover:not(:disabled) {
  filter: brightness(1.08);
}

.ed-pay-cta:disabled {
  opacity: 0.6;
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

.ed-hint {
  margin: 0.25rem 0 0.75rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
}

.ed-hint em {
  font-style: normal;
  background: #f0f0eb;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 0.7rem;
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

.ed-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.4rem;
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
