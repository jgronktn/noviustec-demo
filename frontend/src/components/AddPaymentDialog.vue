<script setup>
import { ref, computed, onMounted, onBeforeUnmount, inject } from "vue";
import {
  getCategories,
  getPaymentSources,
  createTransaction,
} from "../api.js";

const emit = defineEmits(["success", "cancel"]);

const token = inject("apiToken");

const form = ref({
  vendor: "",
  amount: null,
  date: new Date().toISOString().slice(0, 10),
  category: "",
  payment_source: "",
  reference_kind: "check",
  reference_number: "",
  description: "",
  notes: "",
});

const REFERENCE_KINDS = [
  { value: "check", label: "Check" },
  { value: "card", label: "Credit card" },
  { value: "ach", label: "ACH / bank transfer" },
  { value: "wire", label: "Wire" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

const categories = ref([]);
const paymentSources = ref([]);
const error = ref(null);
const loading = ref(true);
const submitting = ref(false);

const canSubmit = computed(
  () =>
    !!form.value.vendor &&
    !!form.value.amount &&
    Number(form.value.amount) > 0 &&
    !!form.value.date &&
    !!form.value.category &&
    !!form.value.payment_source &&
    !submitting.value,
);

function onKeyDown(e) {
  if (e.key === "Escape" && !submitting.value) emit("cancel");
}

onMounted(async () => {
  window.addEventListener("keydown", onKeyDown);
  document.body.style.overflow = "hidden";
  try {
    const [cats, srcs] = await Promise.all([
      getCategories(token.value),
      getPaymentSources(token.value),
    ]);
    categories.value = Array.isArray(cats) ? cats : cats?.categories ?? [];
    paymentSources.value = Array.isArray(srcs) ? srcs : srcs?.sources ?? [];
  } catch (e) {
    error.value = `Couldn't load categories/sources: ${e.message}`;
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  document.body.style.overflow = "";
});

async function submit() {
  if (!canSubmit.value) return;
  error.value = null;
  submitting.value = true;
  try {
    await createTransaction(token.value, {
      vendor: form.value.vendor.trim(),
      amount: Math.abs(Number(form.value.amount)),
      date: form.value.date,
      category: form.value.category,
      payment_source: form.value.payment_source,
      currency: "USD",
      reference_number: form.value.reference_number || "",
      reference_kind: form.value.reference_kind || "",
      description: form.value.description || "",
      notes: form.value.notes || "",
    });
    emit("success");
  } catch (e) {
    error.value = e.message || "Save failed.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="apd-backdrop" @click.self="!submitting && emit('cancel')">
    <div class="apd-card" role="dialog" aria-modal="true">
      <header class="apd-head">
        <div>
          <span class="apd-kicker">Add payment</span>
          <h3 class="apd-title">Quick entry</h3>
          <p class="apd-sub">
            Book a new GL row directly — check, card, ACH, wire, or cash.
          </p>
        </div>
        <button class="apd-close" :disabled="submitting" @click="emit('cancel')" aria-label="Close">×</button>
      </header>

      <p v-if="loading" class="apd-loading">Loading categories and sources…</p>
      <form v-else @submit.prevent="submit" class="apd-form">
        <label class="apd-field apd-wide">
          <span>Vendor *</span>
          <input
            v-model="form.vendor"
            type="text"
            :disabled="submitting"
            placeholder="Who got paid"
            autofocus
          />
        </label>

        <label class="apd-field">
          <span>Amount *</span>
          <input
            v-model.number="form.amount"
            type="number"
            step="0.01"
            min="0.01"
            :disabled="submitting"
          />
        </label>

        <label class="apd-field">
          <span>Date *</span>
          <input v-model="form.date" type="date" :disabled="submitting" />
        </label>

        <label class="apd-field">
          <span>Category *</span>
          <select v-model="form.category" :disabled="submitting">
            <option value="">— pick a category —</option>
            <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </label>

        <label class="apd-field">
          <span>Payment source *</span>
          <select v-model="form.payment_source" :disabled="submitting">
            <option value="">— pick a source —</option>
            <option v-for="s in paymentSources" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
        </label>

        <label class="apd-field">
          <span>Payment method</span>
          <select v-model="form.reference_kind" :disabled="submitting">
            <option v-for="rk in REFERENCE_KINDS" :key="rk.value" :value="rk.value">{{ rk.label }}</option>
          </select>
        </label>

        <label class="apd-field">
          <span>Reference #</span>
          <input
            v-model="form.reference_number"
            type="text"
            :disabled="submitting"
            placeholder="Check #, confirmation, etc."
          />
        </label>

        <label class="apd-field apd-wide">
          <span>Description</span>
          <input
            v-model="form.description"
            type="text"
            :disabled="submitting"
            placeholder="What was paid for"
          />
        </label>

        <label class="apd-field apd-wide">
          <span>Notes</span>
          <input
            v-model="form.notes"
            type="text"
            :disabled="submitting"
            placeholder="(optional)"
          />
        </label>

        <p v-if="error" class="apd-error">{{ error }}</p>

        <div class="apd-actions">
          <button type="button" class="ghost" :disabled="submitting" @click="emit('cancel')">Cancel</button>
          <button type="submit" class="primary" :disabled="!canSubmit">
            {{ submitting ? "Saving…" : "Save payment" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.apd-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 4rem 1rem 2rem;
  z-index: 1000;
  overflow-y: auto;
}

.apd-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(640px, 100%);
  padding: 1rem 1.1rem 1.1rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
}

.apd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.85rem;
  padding-bottom: 0.65rem;
  border-bottom: 1px solid var(--border);
}

.apd-kicker {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  font-weight: 700;
  color: var(--text-muted);
}

.apd-title {
  margin: 0.1rem 0 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text);
}

.apd-sub {
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.apd-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.5rem;
  line-height: 1;
  padding: 0 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}

.apd-close:hover:not(:disabled) {
  background: #f0f0eb;
  color: var(--text);
}

.apd-loading {
  font-size: 0.85rem;
  color: var(--text-muted);
  padding: 1rem 0;
}

.apd-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.55rem 0.7rem;
}

.apd-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.78rem;
  min-width: 0;
}

.apd-field.apd-wide {
  grid-column: span 2;
}

.apd-field > span {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 700;
}

.apd-field input,
.apd-field select {
  font-size: 0.85rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  width: 100%;
}

.apd-field input:focus,
.apd-field select:focus {
  outline: none;
  border-color: var(--accent);
}

.apd-error {
  grid-column: span 2;
  margin: 0;
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.4rem 0.55rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 4px;
}

.apd-actions {
  grid-column: span 2;
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.3rem;
}

button.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 0.82rem;
  padding: 0.4rem 0.85rem;
  border-radius: 4px;
  cursor: pointer;
}

button.ghost:hover:not(:disabled) {
  background: #f5f5f0;
}

button.primary {
  font-size: 0.82rem;
  padding: 0.4rem 0.95rem;
}

button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 600px) {
  .apd-form {
    grid-template-columns: 1fr;
  }
  .apd-field.apd-wide {
    grid-column: span 1;
  }
  .apd-error,
  .apd-actions {
    grid-column: span 1;
  }
}
</style>
