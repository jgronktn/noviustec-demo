<script setup>
import { ref, computed, onMounted, inject } from "vue";
import { getCategories, createCategory, patchCategory } from "../../api.js";

// Props arrive for panel-API consistency, but this panel fetches live data
// so edits reflect immediately rather than from a stale snapshot.
defineProps({
  data: { type: Object, default: () => ({}) },
});

const token = inject("apiToken");

const rows = ref([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);

const newName = ref("");
const newType = ref("expense");

const TYPES = ["expense", "revenue", "transfer"];

const activeCount = computed(() => rows.value.filter(isActive).length);

function isActive(c) {
  return c.active === true || c.active === "TRUE" || c.active === 1;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await getCategories(token.value, { includeArchived: true });
    // Active first, then alphabetical within each group.
    rows.value = [...data.categories].sort((a, b) => {
      const aa = isActive(a) ? 0 : 1;
      const bb = isActive(b) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return String(a.name).localeCompare(String(b.name));
    });
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function run(fn) {
  busy.value = true;
  error.value = "";
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

function add() {
  const name = newName.value.trim();
  if (!name) return;
  run(async () => {
    await createCategory(token.value, { name, type: newType.value });
    newName.value = "";
    newType.value = "expense";
  });
}

function rename(c) {
  const next = window.prompt(`Rename "${c.name}" to:`, c.name);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === c.name) return;
  run(() => patchCategory(token.value, c.name, { name: trimmed }));
}

function changeType(c, value) {
  if (value === c.type) return;
  run(() => patchCategory(token.value, c.name, { type: value }));
}

function toggleArchive(c) {
  run(() => patchCategory(token.value, c.name, { active: !isActive(c) }));
}
</script>

<template>
  <div class="cat-mgr">
    <div class="summary">
      <span class="total">{{ activeCount }}</span>
      <span class="meta">
        active categor<span v-if="activeCount !== 1">ies</span><span v-else>y</span>
        <template v-if="rows.length !== activeCount">
          · {{ rows.length - activeCount }} archived
        </template>
      </span>
    </div>

    <!-- Add row -->
    <form class="add-row" @submit.prevent="add">
      <input
        v-model="newName"
        placeholder="New category name…"
        :disabled="busy"
      />
      <select v-model="newType" :disabled="busy">
        <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <button type="submit" class="primary" :disabled="busy || !newName.trim()">
        Add
      </button>
    </form>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="loading" class="muted pad">Loading…</div>
    <div v-else-if="rows.length === 0" class="muted pad">No categories yet.</div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in rows" :key="c.name" :class="{ archived: !isActive(c) }">
            <td class="name">{{ c.name }}</td>
            <td>
              <select
                :value="c.type"
                :disabled="busy"
                @change="changeType(c, $event.target.value)"
              >
                <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </td>
            <td>
              <span class="pill" :class="isActive(c) ? 'on' : 'off'">
                {{ isActive(c) ? "active" : "archived" }}
              </span>
            </td>
            <td class="actions-col">
              <button class="ghost" :disabled="busy" @click="rename(c)">
                Rename
              </button>
              <button class="ghost" :disabled="busy" @click="toggleArchive(c)">
                {{ isActive(c) ? "Archive" : "Restore" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.cat-mgr {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.summary {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
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

.add-row {
  display: flex;
  gap: 0.5rem;
}

.add-row input {
  flex: 1;
}

.add-row select {
  width: auto;
}

.error {
  color: var(--danger);
  font-size: 0.8rem;
  margin: 0;
}

.muted {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.pad {
  padding: 0.5rem 0;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
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

td select {
  width: auto;
  font-size: 0.8rem;
  padding: 0.15rem 0.3rem;
}

.name {
  font-weight: 600;
}

tr.archived .name {
  color: var(--text-muted);
  text-decoration: line-through;
}

.actions-col {
  text-align: right;
  white-space: nowrap;
}

.actions-col button {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  margin-left: 0.3rem;
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

.pill.on {
  background: #f0fdf4;
  color: var(--ok);
  border: 1px solid #bbf7d0;
}

.pill.off {
  background: #f3f4f6;
  color: var(--text-muted);
  border: 1px solid #e5e7eb;
}
</style>
