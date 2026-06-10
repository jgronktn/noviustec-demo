<script setup>
import { ref } from "vue";
import { healthCheck } from "../api.js";

const emit = defineEmits(["token-set"]);
const value = ref("");
const testing = ref(false);
const error = ref(null);

async function submit() {
  const v = value.value.trim();
  if (!v) {
    error.value = "Token is required";
    return;
  }
  testing.value = true;
  error.value = null;
  try {
    // Lightweight ping. We don't validate the token against the API here —
    // /health is open. The first authenticated call (in InboxPanel) will
    // 401 if the token is wrong; the user can come back and edit it.
    await healthCheck();
    emit("token-set", v);
  } catch (e) {
    error.value = `API unreachable: ${e.message}`;
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <section class="gate">
    <h2>Enter your API token</h2>
    <p class="hint">
      Stored in <code>localStorage</code> on this browser only. The same token
      lives in <code>backend/.env</code> as <code>NOVIUSTEC_API_TOKEN</code>.
    </p>
    <form @submit.prevent="submit">
      <input
        v-model="value"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="paste token..."
        :disabled="testing"
      />
      <button type="submit" class="primary" :disabled="testing">
        {{ testing ? "Checking…" : "Continue" }}
      </button>
    </form>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<style scoped>
.gate {
  max-width: 480px;
  margin: 4rem auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2rem;
  box-shadow: var(--shadow);
}

h2 {
  margin: 0 0 0.5rem;
  font-size: 1.25rem;
  font-weight: 600;
}

.hint {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0 0 1.5rem;
}

form {
  display: flex;
  gap: 0.5rem;
}

form input {
  flex: 1;
}

.error {
  color: var(--danger);
  font-size: 13px;
  margin: 1rem 0 0;
}
</style>
