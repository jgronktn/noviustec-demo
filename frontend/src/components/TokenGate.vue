<script setup>
import { ref } from "vue";
import { getCategories } from "../api.js";

const emit = defineEmits(["token-set"]);

// `initialError` lets the parent explain why the gate reappeared — e.g. a
// token that was accepted earlier but later rejected mid-session (server
// token rotated, etc.). Shown until the user edits the field.
const props = defineProps({
  initialError: { type: String, default: "" },
});

const value = ref("");
const testing = ref(false);
const error = ref(props.initialError || null);

// Where the bundle was built to talk to — used only for the "unreachable"
// message so the user can sanity-check they're pointed at the right API.
const API_URL = import.meta.env.VITE_API_URL || "this origin";

async function submit() {
  const v = value.value.trim();
  if (!v) {
    error.value = "Token is required";
    return;
  }
  testing.value = true;
  error.value = null;
  try {
    // Validate the token with a real authenticated call BEFORE accepting it,
    // so a bad token fails here with a clear message instead of being stored
    // and then silently bouncing the user back from inside the app.
    await getCategories(v);
    emit("token-set", v);
  } catch (e) {
    if (e.status === 401) {
      error.value =
        "That token was rejected. Make sure you copied the full token and " +
        "that it matches NOVIUSTEC_API_TOKEN in the backend .env (the demo " +
        "and production tokens are different).";
    } else if (e.status) {
      error.value = `Server returned an error (HTTP ${e.status}). Try again in a moment.`;
    } else {
      error.value = `Couldn't reach the API at ${API_URL}. Check the service is up and try again.`;
    }
  } finally {
    testing.value = false;
  }
}

// Clear a lingering error as soon as the user starts editing the field.
function onInput() {
  if (error.value) error.value = null;
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
        @input="onInput"
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
