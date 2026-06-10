# Noviustec — Demo

AI-powered bookkeeping control center for SMB executives. Currently in early
development, dogfooded against the founder's own startup's books.

> **This is the demo deployment**, a separate fork of the production
> `noviustec` repo. It runs on the **same physical box as production**
> (`159.223.131.121` — all four of `api`/`app`/`api-demo`/`demo`
> `.noviustec.com` resolve there), isolated only at the OS level via a
> dedicated `demo` user. It serves `demo.noviustec.com` /
> `api-demo.noviustec.com` with the `demo.noviustec.com` Postmark inbound
> subdomain, and **shares the same Anthropic API key and Postmark server
> token** as production (see `.env`). Code is identical to prod except for
> the deployment identity (domains, systemd service name, GitHub remote,
> and **`PORT=3001`** so it doesn't collide with prod's `:3000`). Keep this
> fork's config separate from prod's — don't point demo at prod's domains
> or vice versa.

## What we're building

An exec-facing tool where the CEO or CFO interacts with their company's
financial state through a chat interface backed by an AI agent. The agent
reads bookkeeping data, parses incoming receipts, generates reports, and
proposes write actions (which the user explicitly approves).

The product wedge is the canvas-driven UX: chat is a thin input rail,
and most of the screen is a dashboard that Claude reshapes based on what
the user asks. This differs from chat-first tools like Bookkeeping.ai.

Long term: starts with bookkeeping, expands to sales metrics, HR, operations
— a unified control center per company.

Customers eventually outgrow our simple ledger and migrate to QuickBooks
or Xero. This migration is a feature, not a failure mode — clean books in
their preferred system.

## Current state (May 2026)

### Working on the demo server
- Node.js + Fastify backend at `api-demo.noviustec.com` (nginx + TLS + systemd)
- Static frontend at `demo.noviustec.com` (nginx)
- Postmark Inbound Parse (`demo.noviustec.com` subdomain) → `/webhooks/postmark-inbound`
- Real receipts arriving and saving to `inbound-log/` on the server
- Frontend can fetch from API with CORS configured

### Not built yet
- Receipt parser (Claude Haiku vision call on saved attachments)
- PendingInbox approval flow
- Excel ledger (GL, sources, categories sheets) — `.xlsx` via `exceljs`
- The agent loop with bookkeeping tools
- Per-company routing (currently using random Postmark address)
- Persistent user accounts / auth (currently single-user, no login)
- Database — sticking with file-based storage until needed

## Architecture

Browser → demo.noviustec.com (frontend, static HTML/JS)
↓ fetch (CORS)
→ api-demo.noviustec.com (nginx + TLS)
↓ proxy
→ Node :3001 (Fastify, systemd service noviustec-demo-api; prod uses :3000)
↓
→ Files on disk, Anthropic API, Postmark webhooks
Postmark Inbound Parse
↓ POST
→ api-demo.noviustec.com/webhooks/postmark-inbound
→ saves JSON payload + base64 attachments to inbound-log/

## Repository structure
noviustec-demo/
├── CLAUDE.md                  ← this file
├── .gitignore                 (ignores node_modules, inbound-log, companies, .env)
├── backend/
│   ├── server.js              ← main Fastify entry point
│   ├── package.json
│   ├── package-lock.json
│   ├── .env                   ← gitignored; ANTHROPIC_API_KEY, POSTMARK_TOKEN
│   ├── inbound-log/           ← gitignored; saved Postmark payloads + -parsed.json sidecars
│   ├── companies/             ← gitignored; per-company ledger files
│   │   └── default/
│   │       └── ledger.xlsx    ← Excel workbook (Categories, Sources, PendingInbox, GL)
│   ├── src/
│   │   ├── parser/            ← receipt parser (Haiku 4.5 vision)
│   │   │   ├── index.js
│   │   │   ├── triage.js
│   │   │   ├── normalize.js
│   │   │   ├── inline-html.js
│   │   │   ├── prompts.js
│   │   │   ├── schema.js
│   │   │   └── claude.js
│   │   └── ledger/            ← exceljs-backed ledger workbook
│   │       ├── index.js
│   │       ├── workbook.js
│   │       ├── schema.js
│   │       ├── categories.js
│   │       ├── sources.js
│   │       ├── pending.js
│   │       └── transactions.js
│   └── scripts/
│       ├── parse-fixtures.js  ← run parser against backend/inbound-log/
│       ├── init-ledger.js     ← create the workbook with seeded categories
│       └── inspect-ledger.js  ← dump current ledger state
├── frontend/
│   └── index.html             ← current frontend (plain HTML/JS; Vue 3 + Vite planned)
└── docs/
    └── decisions.md           ← log of architectural decisions and rationale

## Stack and conventions

- **Language**: Node.js 22 LTS, ESM modules (`"type": "module"` in package.json)
- **Web framework**: Fastify 5.x
- **Logging**: Pino (Fastify default), structured JSON
- **AI**: Anthropic API
  - Sonnet 4.6 for the agent loop (`claude-sonnet-4-6`)
  - Haiku 4.5 for receipt parsing (`claude-haiku-4-5-20251001`)
- **Inbound mail**: Postmark Inbound Parse (chose over SendGrid after extensive
  debugging; see `docs/decisions.md`)
- **Frontend**: Plain HTML/JS today; planned to become **Vue 3 + Vite** once
  the receipt-parser and ledger backend are in place and canvas UI work begins.
  Don't add the framework before there's real UI to build against.
- **Storage**: Files on disk for v1. One Excel workbook per company (planned).
  Postgres only if we genuinely outgrow files.
- **Process management**: systemd (service: `noviustec-demo-api`)
- **TLS**: Let's Encrypt via certbot, auto-renewing

## Key design decisions

These are settled. Don't relitigate without strong reason; see
`docs/decisions.md` for context.

- **Cash basis only in v1.** Accrual is post-v1.
- **Excel as the v1 ledger format.** Migrate to Postgres only when needed.
  Customers can graduate to QuickBooks/Xero when they outgrow us.
- **Canvas-driven UI, not chat-first.** Chat is a thin rail; the canvas is
  the primary surface. Claude orchestrates panels via canvas tools.
- **Propose-then-approve for writes.** Any mutation requires explicit user
  approval. Reads can be speculative. Never let the agent write to books
  directly.
- **Curated tool surface, not raw SQL/API access.** Claude gets domain-
  meaningful tools (`qbo_get_pnl`, `add_transaction`) rather than generic
  query primitives. Prevents hallucinated field names and uncontrolled cost.
- **Per-user sandboxing.** Each company's files live under
  `backend/companies/{companyId}/` (resolved relative to the deployed
  backend directory — `/home/demo/backend/companies/...` in
  production). Strict path validation via a `resolveSafe()` helper.
- **Native tools, not MCP.** Filesystem and ledger operations are implemented
  as native Anthropic tool definitions inside the Node process. MCP would
  add subprocess overhead and complicate sandboxing.
- **Single Anthropic account, not BYOK.** Customers pay us, we pay Anthropic.
  Per-user token quotas and usage tracking are required.

## Conventions for Claude Code sessions

When writing code in this repo:

- Use ESM imports (`import x from 'y'`), never `require`
- All API routes go under `/api/`; webhooks go under `/webhooks/`
- Return JSON from all API routes
- Validate inputs at the route handler (Fastify schemas preferred)
- Use Pino's structured logging — `req.log.info({ key: value }, "message")`
  rather than string concatenation
- Tool handlers for the agent live under `backend/src/agent/handlers/`
  (when the agent loop exists)
- Tool definitions (JSON schemas) live in `backend/src/agent/tools.js`
- Never let an LLM-driven write tool execute without an approval gate
- Path validation: use a `resolveSafe()` helper for any user-supplied path
- Always handle Postmark webhook errors with `return reply.code(200).send(...)`
  — non-200 responses cause Postmark to retry, which we don't want for parse
  failures

## Development workflow

- Code lives on the developer's laptop in this monorepo (under `~/code/demo/`)
- This fork has its own GitHub repo (`noviustec-demo`), separate from prod's
  `noviustec` repo — push demo work there, not to prod
- Develop locally, commit to git, push to GitHub
- Server deploys from GitHub via `git pull` in `/home/demo/` followed
  by `npm install` (if deps changed) and `sudo systemctl restart noviustec-demo-api`
- Never edit files directly on the server (`api-demo.noviustec.com`)
- The `scripts/deploy-backend.sh` and `scripts/deploy-frontend.sh` scripts
  mentioned in earlier plans were never created — current process is the
  manual git-pull flow described above

### Server layout

The demo runs under a dedicated `demo` user, isolated from prod's
`noviustec` user (separate home, permissions, and files — easy to wipe and
recreate without touching prod). Just as `~/code/demo/` is the repo root
locally, `/home/demo/` is the repo root on the server (cloned directly into
the `demo` user's home directory).

- **Repo root on server**: `/home/demo/`
- **Backend working dir**: `/home/demo/backend/`
- **Backend env file**: `/home/demo/backend/.env` (loaded by systemd via `EnvironmentFile=`)
- **Backend port**: `3001` (set `PORT=3001` in `.env`; prod's `noviustec-api` owns `:3000` on this shared box)
- **Ledger location**: `/home/demo/backend/companies/default/ledger.xlsx` (not in git)
- **Inbound log**: `/home/demo/backend/inbound-log/` (not in git)
- **systemd service**: `noviustec-demo-api`
- **SSH user**: `demo@api-demo.noviustec.com`

### Useful commands

```bash
# Run backend locally
cd backend && node server.js

# Run backend in watch mode
cd backend && node --watch server.js

# Deploy: pull on server, install if package.json changed, restart
ssh demo@api-demo.noviustec.com '
  cd /home/demo &&
  git pull &&
  cd backend && npm install &&
  sudo systemctl restart noviustec-demo-api
'

# SSH to server
ssh demo@api-demo.noviustec.com

# Tail server logs
ssh demo@api-demo.noviustec.com 'sudo journalctl -u noviustec-demo-api -f'

# Restart backend service
ssh demo@api-demo.noviustec.com 'sudo systemctl restart noviustec-demo-api'

# Inspect the demo ledger (read-only)
ssh demo@api-demo.noviustec.com 'cd /home/demo/backend && npm run inspect-ledger'
```

## Files of note

- `backend/server.js` — main entry, route registrations, currently includes
  the `/webhooks/postmark-inbound` handler that saves payloads
- `backend/inbound-log/` — saved Postmark JSON payloads, gitignored, but
  useful as a corpus of real test fixtures for parser development
- `frontend/index.html` — minimal page that fetches from the API
- `docs/decisions.md` — running log of architectural decisions and why

## What to read first in a new Claude Code session

1. This file (you're here)
2. `backend/server.js` — current API surface
3. `frontend/index.html` — current frontend
4. The most recent file in `backend/inbound-log/` — to see the shape of
   real Postmark payloads

## Things Claude Code should know

- The Postmark inbound webhook receives JSON, not multipart. Don't add
  multipart parsing for this endpoint.
- Postmark payloads have an `Attachments` array with base64-encoded
  `Content`. Decoding to Buffer is the standard pattern.
- When working with email forwards, watch for `message/rfc822` attachments
  — these are nested emails containing the real receipt. Use the `mailparser`
  library to unwrap them.
- Cloud-link references (Google Drive, OneDrive, Dropbox, WeTransfer)
  in email bodies should be detected and surface a "needs user action"
  message rather than silently failing.
- Receipt parsing uses Haiku 4.5 with vision. The prompt should pass the
  user's actual categories and payment sources as context so Claude proposes
  best-fit categorizations rather than generic guesses.
- For cost reasons, mark the system prompt and tool definitions as
  `cache_control: { type: "ephemeral" }` in agent loop API calls. This
  drops input costs ~90% on follow-up turns within a session.

## Sensitive notes

- The Anthropic API key lives in `backend/.env` on the server
  (not committed; loaded by systemd via `EnvironmentFile=`)
- Postmark server token lives in the same `.env`
- Never log API keys, tokens, or Postmark webhook bodies containing
  customer financial data at INFO level. DEBUG only, and only locally.
- Personal financial data in `inbound-log/` is treated as sensitive — these
  files are gitignored and only exist on the server

## Out of scope (do not build)

These are intentionally not part of v1:

- Multi-currency support
- Accrual accounting
- Payroll integration
- Tax filing
- Multi-entity / intercompany
- AR invoicing (sending invoices to customers — only receiving)
- Bank feeds (Plaid integration) — manual statement upload only
- Sub-accounts in QuickBooks-style chart of accounts hierarchy

Each of these is a real future feature. None belongs in v1.

## Decisions log

For the why behind major choices, see `docs/decisions.md`.

The short list of "things to know we already debated":

- SendGrid vs Postmark for inbound mail (Postmark won)
- Excel vs Postgres for v1 storage (Excel won — simpler, customers can graduate)
- MCP vs native tools (native won — simpler for this single-Node-process case)
- BYOK vs single-account billing (single-account won — better UX and pricing)
- Build bookkeeping from scratch vs integrate with QuickBooks (build for now,
  integrate eventually — currently in "build" phase)