<script setup>
import { ref, inject, onMounted } from "vue";
import {
  recordPayment,
  getCategories,
  getPaymentSources,
} from "../api.js";

const props = defineProps({
  // { id, vendor, amount, currency, reference_number?, date? }
  awaiting: { type: Object, required: true },
});
const emit = defineEmits(["success", "cancel"]);

const token = inject("apiToken");

const today = new Date().toISOString().slice(0, 10);

const form = ref({
  date: today,
  category: "",
  payment_source: "",
  reference_number: "",
  reference_kind: "confirmation",
  notes: "",
});

const REFERENCE_KINDS = [
  { value: "confirmation", label: "Confirmation #" },
  { value: "transaction", label: "Check / Transaction #" },
  { value: "receipt", label: "Receipt #" },
  { value: "invoice", label: "Invoice #" },
  { value: "order", label: "Order #" },
  { value: "other", label: "Other" },
];

const categories = ref([]);
const paymentSources = ref([]);
const loadingLookups = ref(true);
const submitting = ref(false);
const error = ref(null);

async function loadLookups() {
  try {
    const [c, s] = await Promise.all([
      getCategories(token.value),
      getPaymentSources(token.value),
    ]);
    categories.value = c.categories ?? [];
    paymentSources.value = s.sources ?? [];
  } catch {
    /* surface only if user submits */
  } finally {
    loadingLookups.value = false;
  }
}

onMounted(loadLookups);

async function submit() {
  error.value = null;
  if (!form.value.date) {
    error.value = "Payment date is required.";
    return;
  }
  if (!form.value.category) {
    error.value = "Category is required.";
    return;
  }
  if (!form.value.payment_source) {
    error.value = "Payment source is required.";
    return;
  }

  submitting.value = true;
  try {
    await recordPayment(token.value, props.awaiting.id, {
      date: form.value.date,
      category: form.value.category,
      payment_source: form.value.payment_source,
      reference_number: form.value.reference_number || null,
      reference_kind: form.value.reference_number
        ? form.value.reference_kind
        : null,
      notes: form.value.notes || "",
    });
    emit("success");
  } catch (e) {
    error.value = e.message || "Failed to record payment.";
  } finally {
    submitting.value = false;
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
</script>

<template>
  <form class="rpf" @submit.prevent="submit">
    <div class="rpf-grid">
      <label>
        <span>Payment date</span>
        <input type="date" v-model="form.date" required />
      </label>
      <label>
        <span>Category</span>
        <select v-model="form.category" required>
          <option value="" disabled>
            {{ loadingLookups ? "Loading…" : "Pick one" }}
          </option>
          <option v-for="c in categories" :key="c.name" :value="c.name">
            {{ c.name }}
          </option>
        </select>
      </label>
      <label>
        <span>Payment source</span>
        <input
          type="text"
          list="rpf-payment-sources"
          v-model="form.payment_source"
          :placeholder="loadingLookups ? 'Loading…' : 'Card / bank / cash — type or pick'"
          required
        />
        <datalist id="rpf-payment-sources">
          <option v-for="s in paymentSources" :key="s.name" :value="s.name">
            {{ s.last4 ? `${s.name} · ••${s.last4}` : s.name }}
          </option>
        </datalist>
        <span
          v-if="paymentSources.length === 0 && !loadingLookups"
          class="rpf-hint"
        >No sources on file — typing one will save it for next time.</span>
      </label>
      <label>
        <span>Reference number</span>
        <input
          type="text"
          v-model="form.reference_number"
          placeholder="check # / confirmation / last 4"
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
    <label class="rpf-notes">
      <span>Notes (optional)</span>
      <input
        type="text"
        v-model="form.notes"
        placeholder="e.g. mailed check, manual entry"
      />
    </label>

    <p v-if="error" class="rpf-error">{{ error }}</p>

    <div class="rpf-actions">
      <span class="rpf-summary">
        Book {{ fmt(awaiting.amount, awaiting.currency) }} to {{ awaiting.vendor }}
      </span>
      <button
        type="button"
        class="ghost"
        :disabled="submitting"
        @click="emit('cancel')"
      >Cancel</button>
      <button type="submit" class="primary" :disabled="submitting">
        {{ submitting ? "Saving…" : "Record payment" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.rpf {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.rpf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.55rem 0.65rem;
}

.rpf label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.rpf label span {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.65rem;
}

.rpf input,
.rpf select {
  font-size: 0.85rem;
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.rpf-hint {
  font-size: 0.7rem !important;
  color: var(--text-muted) !important;
  font-style: italic;
  text-transform: none !important;
  letter-spacing: 0 !important;
  font-weight: 400 !important;
  margin-top: 0.1rem;
}

.rpf-error {
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.35rem 0.55rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
}

.rpf-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: flex-end;
}

.rpf-summary {
  margin-right: auto;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
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
