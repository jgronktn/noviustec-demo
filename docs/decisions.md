# Decisions log

Append-only log of major decisions and the reasoning behind them.
Format: date, decision, rationale, what would cause us to reconsider.

---

## 2026-05 — Postmark for inbound mail, not SendGrid

Spent half a day debugging SendGrid Inbound Parse rejecting mail with
`550 Mailbox not found` despite correct DNS, verified domain authentication,
and complete Inbound Parse host configuration. Switched to Postmark, worked
first try.

Postmark is $15/month vs SendGrid's free tier, but the time savings
massively outweigh the cost difference. Postmark's inbound activity dashboard
is far superior, payload is cleaner JSON, and webhook delivery diagnostics
actually work.

Would reconsider only if: Postmark pricing changes dramatically, or we hit
their scale limits (10k+ inbound/mo — unlikely soon).

## 2026-05 — Excel as v1 ledger format

Considered Postgres from day one. Decided against because:
- Bookkeeping schemas are easy to get wrong without real usage feedback
- Customers can hand us their QuickBooks Excel exports as design partners
- Migration to Postgres is well-understood when needed (after PMF, not before)
- Excel files are inspectable by hand, which makes debugging dramatically easier

Would reconsider when: multi-user write contention becomes a real problem,
or when transaction volume exceeds ~10-20k per customer (a few years of books
for typical SMB).

## 2026-05 — Cash basis only in v1

Most SMB customers actually operate on cash basis day-to-day, even when their
accountant converts to accrual for taxes. Cash basis is dramatically simpler
to model. Doesn't preclude accrual later.

Would reconsider when: first paying customer specifically needs accrual books
for investor reporting.

## 2026-05 — Single Anthropic account, not BYOK

Researched Anthropic policy: third-party "Login with Claude" is explicitly
prohibited. BYOK (each customer brings their own API key) is allowed but
has terrible UX — customers would have to set up billing at console.anthropic.com.

Decided we eat the Claude costs and bill customers a flat subscription.
Margin will be ~80% with proper cost controls (caching, model routing, quotas).

Would reconsider when: a large customer specifically wants their own account
relationship with Anthropic for compliance reasons.

## 2026-05 — Native tools vs MCP for backend tool calls

The MCP filesystem server is great for desktop client scenarios. For our
single-Node-process backend, MCP adds subprocess overhead, complicates
per-user sandboxing, and doesn't unlock anything we need.

Native Anthropic tool definitions in the Fastify handler are simpler,
faster, and easier to audit.

Would reconsider when: we need to share tool implementations across
multiple clients or agents (likely never, given our architecture).

## 2026-05 — Build bookkeeping from scratch, then graduate customers to QuickBooks

Considered building on top of QuickBooks/Xero from day one. Decided against
for v1 because:
- Their data models constrain product UX
- Customers comparing to "AI for QuickBooks" want something more native
- Migration to QB/Xero on graduation becomes a feature ("no lock-in")

This is a reversible decision. If we discover customers strongly want
QuickBooks integration from day one, we add it as a second mode rather
than rebuilding.

## 2026-05 — Vue 3 + Vite for the frontend (replacing the prior React+Vite plan)

CLAUDE.md previously said the frontend would become React+Vite once complexity
warranted. Switching to Vue 3 + Vite instead. Driven by founder familiarity
and the SFC ergonomics fitting the canvas-driven UI plan (one component per
panel, clear template/script/style separation makes it easy for Claude to
generate and edit panels via canvas tools).

Frontend is still plain HTML/JS today and will stay that way until the
receipt parser and ledger backend exist — adding Vue earlier just creates
build complexity with nothing to render.

Would reconsider when: the team grows past the founder and the new hires
have strong React experience, OR if a canvas-tool implementation turns out
to be materially harder in Vue's reactivity model than React's.