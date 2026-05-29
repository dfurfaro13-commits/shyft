# SHIFT — Claude Code project notes

The product is **SHIFT Scheduling** (call it **SHIFT** for short) — a scheduling application **for medical professionals**. Providers sign up for / bid on shifts, an admin reconciles, a marketplace handles last-minute trades. Built around a phased lifecycle (availability → reconciliation → locked) with a points-based priority system.

This file is the catch-up brief for Claude Code instances joining the project mid-stream. **Read it first** before exploring code — the architecture has a few non-obvious gotchas that will burn time if you discover them by accident.

> **Naming note for Claude:** the codebase predates the rebrand and still uses **`shyft`** in technical identifiers — JSX source name (`ShiftApp.v3.jsx`), templates (`templates/shyft_head.v3.html`, `templates/shyft_tail.v3.html`), the localStorage namespace (`shyft3_*`), and the migration markers (`shyft3_migrate_from_v2`, `shyft3_g{gid}_migrate_top_options`). **Leave these alone.** Renaming the storage namespace would invalidate every existing user's data. Only update brand mentions in user-facing UI strings, comments, and docs. (The old `SUPER_BOOTSTRAP = "Shyft-Kai-Dave"` constant moved to a Worker secret, `OWNER_BOOTSTRAP_CODE`, in D.3 — same value, different home. The built artifact moved from `shyft-v3.html` to `index.html` when the deploy URL switched to `www.shift-scheduling.com/`.)

---

## Product principles

The interface must be **clean, professional, simple, and intuitive.** This is the audience's standing requirement — medical professionals don't have time to learn a complex tool, and the UI carries the credibility of the product. When in doubt, simplify. When asked between "more powerful" and "easier to understand," pick easier. Recent design moves (e.g. the v3.1 collapse from per-slot pools + per-day preference into a single 4-state Top Option model) are worked examples of this principle.

## Project scope & constraints

- **Hobby project.** David is building this on his own time. Recurring costs ≈ $0 — Cloudflare's free tier covers Workers, D1, and R2 at our current scale. No paid SaaS, no per-seat licenses. Flag anything that would change that.
- **Cloud is authoritative; localStorage is a cache.** As of D.4.D2 (shipped), `loadGroup` pulls from cloud (snapshot + event-tail replay), every mutation routes through `applyAndTrack → applyEvent → setX + persist + POST /api/events`, a 15s periodic poll syncs cross-device, and the snapshot uploader is a 30s-debounced compaction job gated on "dirty since last upload". localStorage still holds the per-group cache so the UI works offline-read-only, but the reducer is the single source of truth for state transitions.
- **Hosted as a website.** Deployed to Cloudflare Pages + Worker at `www.shift-scheduling.com` (root path serves the app).
- **Design for the reducer.** New mutations go through `applyAndTrack(type, payload, opts)`. Add a handler to `EVENT_HANDLERS` in the head template (mirror the reference stub in the JSX preamble), capture any non-deterministic inputs (`Date.now()`, `Math.random()`) into the payload, and route the producer through `applyAndTrack`. The dispatcher handles the slice-diff dispatch + POST + outbox.

---

## Active version: v3 (with v3.1 simplification)

Only v3 is active. v1 and v2 are archived under `legacy/`.

| Version | Source | Built artifact | Status |
|---------|--------|----------------|--------|
| v1 | `legacy/ShiftApp.jsx` | `legacy/shyft.html` | Frozen archive — do not read |
| v2 | `legacy/ShiftApp.v2.jsx` | `legacy/shyft-v2.html` | Frozen archive — do not read |
| **v3** | **`ShiftApp.v3.jsx`** | **`index.html`** | **Active — all new work goes here** |

**Never read or grep into `legacy/`.** Those files exist only for git history and as a paper trail; they are not relevant to any current task. If a question seems to require v1/v2 logic, ask first — usually the answer is "the spec doc" or "the v3 implementation," not the archived source.

v3 forked from v2 to add the phase state machine, confirm/flag, marketplace, and lock-time crediting. v3.1 (current) replaced the per-slot pool model with a per-day "Top Option" model — see [Top Option model](#top-option-model-v31-current) below.

Each version has its own localStorage namespace:
- v1/v2: `shyft_*` (shared)
- **v3: `shyft3_*` (separate — won't collide with v2)**

v3 imports v2 data once on first load via the `shyft3_migrate_from_v2` marker.

---

## Build pipeline (read carefully)

The runtime artifact is **assembled from three pieces**, not edited directly:

```
[templates/shyft_head.v3.html]   ← module-scope constants, helpers, migration code
       ↓
[ShiftApp.v3.jsx, lines from `^export default function ShiftApp` onward]
       ↓
[templates/shyft_tail.v3.html]   ← <ReactDOM.createRoot(...).render(<ShiftApp/>)>
       ↓
index.html
```

Build command — run from the project root (the folder that contains `ShiftApp.v3.jsx` and `templates/`):

```bash
N=$(grep -n "^export default function ShiftApp" ShiftApp.v3.jsx | cut -d: -f1)
{ cat templates/shyft_head.v3.html
  tail -n +"$N" ShiftApp.v3.jsx | sed 's/^export default function ShiftApp/function ShiftApp/'
  cat templates/shyft_tail.v3.html
} > index.html
```

After every build, sanity-check braces:

```bash
o=$(grep -o '{' index.html | wc -l) && c=$(grep -o '}' index.html | wc -l) && echo "$o/$c"
```

If they don't match, you have a syntax error.

### ⚠ Critical gotcha: head-template sync

**Everything in `ShiftApp.v3.jsx` before `export default function ShiftApp` is reference-only.** It exists for IDE readability but is **never** in the runtime build — the `tail -n +N` strips it. The actual runtime constants and helpers live in `templates/shyft_head.v3.html`.

There are two flavors of preamble code, and they have different sync rules:

1. **General module-scope helpers** (top of the preamble — `DEFAULT_CONFIG`, `PHASE` constants, `phaseOf`, `getUid`, `dk`, `parseDk`, `currentBlockOf`, etc.) are **mirrored in full** in both files. If you change one in the JSX preamble, you MUST mirror the change in the head template, or it won't take effect.

2. **The reducer family** (everything from the `D.4.C — applyEvent reducer (REFERENCE-ONLY STUBS)` banner down — the helpers `trackAppliedEventId`, `applyAwardsToShifts`, etc., plus `EVENT_HANDLERS`, `applyEvent`, `normalizeForDiff`, `diffState`) is **stubs-only in the JSX preamble** (signatures return their first arg or a no-op value). The canonical implementations live only in the head template. When you add or modify reducer logic, edit the head template; mirror only the signature into the JSX preamble for IDE awareness.

This split exists because the reducer family is ~600 lines of business logic — full duplication would create silent drift. The general helpers are short, stable, and benefit from full mirroring so the IDE shows their behavior.

Component-local helpers (anything inside `function ShiftApp(...)`) only need updating in the JSX — they're inside the slice that gets included.

---

## File map

| Path | Role |
|------|------|
| `ShiftApp.v3.jsx` | Source of truth for all v3 code. Edit this. |
| `templates/shyft_head.v3.html` | Runtime preamble (DOCTYPE, Tailwind config, migration, module-scope helpers, `applyEvent` reducer). Mirror module-scope code here. |
| `templates/shyft_tail.v3.html` | Runtime postamble. Just `<ReactDOM>.render()`. Don't touch. |
| `index.html` | Built artifact. **Never edit by hand** — gets overwritten. Cloudflare serves this at `/`. |
| `wrangler.jsonc` | Cloudflare Worker config. Binds the API Worker (`_worker.js`), D1 (`DB`), and R2 (`R2`). |
| `_worker.js` | Worker entrypoint. Routes `/api/*` to the API; everything else falls through to static assets via `env.ASSETS.fetch`. Apex (`shift-scheduling.com`) and www are both bound as custom domains and serve the app directly — no 301 redirect. Cookies share via `Domain=shift-scheduling.com` (see [src/lib/cookies.js](src/lib/cookies.js)) so a session set on one host is honored on the other. |
| `src/api/` | API handlers + `router.js`. Modules: `auth`, `signup`, `users`, `groups`, `owner`, `profile` (self-service display name / password / change-email-request), `reset` (forgot-password), `events`, `snapshots`. |
| `src/lib/` | Backend helpers (`db`, `session`, `cookies`, `email`, `csrf`, `ids`, `ratelimit`, `http`, `passwords`). |
| `migrations/0001_init.sql` | D1 schema for Phase A: `users`, `groups`, `memberships`, `invites`, `login_tokens`, `sessions`. |
| `migrations/0002_events.sql` | Phase B append-only event log (`events` table). |
| `migrations/0003_snapshots.sql` | Phase C per-group state snapshot (`snapshots` table). Latest only — full history lives in R2. |
| `migrations/0004_users_passwords.sql` | Phase D.1: adds `users.password_hash`, `users.kind`, and `password_attempts` rate-limit table. |
| `migrations/0005_username_owner.sql` | Phase D.3: adds `users.username` (partial unique), `users.can_create_groups`, `groups.group_code`, `groups.admin_code`, plus `signup_attempts`. Backfills owner permission + group/admin codes from snapshots. |
| `migrations/0006_email_changes.sql` | Self-service profile: `email_change_tokens` table backing the magic-link email-confirmation step of `POST /api/me/change-email-request`. |
| `migrations/0007_password_reset_tokens.sql` | Forgot-password: `password_reset_tokens` table backing `POST /api/auth/forgot-password` + the server-rendered `GET /api/auth/reset-password` form. |
| `legacy/` | Archived v1/v2 source + built HTML, plus v1-era assignment-algorithm simulators. **Do not read or grep into.** |

---

## Backend (Cloudflare Worker + D1 + R2)

Cloud is the source of truth. Mutations flow `applyAndTrack` → reducer (pure) → `setX + persist` + `POST /api/events`. A 15s periodic poll syncs cross-device; the snapshot uploader is a 30s-debounced compaction job. localStorage is a per-group cache, downstream of the reducer.

**Deploy / local dev:**
- Deploy: `npx wrangler deploy`. First-time setup: `wrangler login`; `d1 create shift-db` (paste id into `wrangler.jsonc`); run each `migrations/000*.sql` via `d1 execute shift-db --remote --file=…`; `r2 bucket create shift-events`; `wrangler secret put RESEND_API_KEY`, `SESSION_PEPPER`, `OWNER_BOOTSTRAP_CODE`.
- Local: `npx wrangler dev --remote` runs the Worker at `localhost:8787` against deployed D1 / R2. Create `.dev.vars` (gitignored) with `RESEND_API_KEY=…` and `DEV_EMAIL=console` to log magic links to stdout.
- Email: Resend on `shift-scheduling.com`, sender `noreply@shift-scheduling.com`.
- Deploy hygiene: `assets.directory` is `./` (worktree root), so `.assetsignore` is the gate. Sanity-check what `wrangler deploy` reports as new uploads before pushing.

**CSRF / sessions:** every state-changing API call needs `X-Requested-With: shift` (the `window.api.fetchJSON` shim adds it). Sessions: opaque `shift_sid` cookie; server stores `SHA-256(SESSION_PEPPER + raw)`. Cookies share via `Domain=shift-scheduling.com` so apex + www are interchangeable.

### Event log (`POST /api/events`)

- Allowed types whitelisted in `ALLOWED_TYPES` ([src/api/events.js](src/api/events.js)). To add a new event type, append there first or the Worker rejects with 400.
- Response: `{ id, serverTs }`. **Consumers MUST dedupe by event `id`** — `server_ts` is second-granular and events can share a tick.
- Tail: `GET /api/events?gid=&since=&limit=&type=`. Default 500, max 2000, soft 512 KB cap. `nextCursor` = last returned `serverTs` (inclusive).
- **Outbox:** `localStorage.shyft3_evt_outbox` parks bodies on transport failure (cap 500). Flushes on `visibilitychange→visible`, `online`, and microtask on load. 4xx drops. UI surfaces queue depth via an amber "📭 N queued · syncing…" badge top-right; toasts on first-queued ("📭 Saved locally"), full-flush ("✅ Synced"), and server reject ("⚠ Server rejected"). Server still mints event ids, so transport-failure retries can theoretically create duplicates — fine because the outbox only fires when the request never reached the server. Client UUIDs + `INSERT OR IGNORE` are deferred.
- **Per-tab client id:** `SHYFT_CLIENT_ID` (sessionStorage UUID; module-scope constant in head template + mirrored stub in JSX preamble). Stamped into every event payload by `buildEventBody`; cross-device poll filters on `evt.payload.clientId === SHYFT_CLIENT_ID` to skip own-tab events. Legacy events without `clientId` fall back to the old `localUid` filter.
- **Local event id stamp:** `applyAndTrack` stamps `local_${Date.now()}_${rand}` on each event before running the reducer, so `applyEvent`'s `if (!evt.id) return state` guard doesn't bail. The local id is NOT in the body POSTed to the server (server still mints the canonical id).
- R2 archival of the event log is deferred — D1 is queryable directly, monthly dumps wait until the corpus grows.

### Reducer (`applyEvent` in head template)

- Pure: no `Date.now()`, no `Math.random()`, no clock reads. Non-deterministic inputs must travel in payload — see D.4.B-era enrichments: `block.reconcile.awards` (flat `{dateKey, slotId, uid, source, auto, bid?}`), `topOption.clear.chainRepair`, `shift.flag.listing`, etc.
- Idempotent via a FIFO `appliedEventIds` ring (cap 200). Unknown event types are forward-compat no-ops.
- **Validator:** `await window.__shiftValidator.run()` (cloud-owner only) replays events through `applyEvent` and deep-diffs against live state. Expect `✅ 0 divergences`. The historical shadow-diff inside `trackEvent` was removed; the validator is the only divergence detector now.
- **`applyAndTrack` flow:** producer captures non-determinism into payload → `applyAndTrack` stamps local id → runs reducer → object-identity diffs each slice → `setX + persist`s only the changed slices → POSTs the body. Shadow-diff is intentionally bypassed because predicted == actual by construction.

### Snapshots (`POST /api/snapshots`)

- Debounced 30s, gated by a `snapshotDirty` ref set by `persist()`. D1 stores latest (one row per group); R2 stores history at `snapshots/<groupId>/<server_ts>-<client_ts>.json`. Snapshot is a compaction optimization + rehydration baseline — event log + poll are authoritative for realtime sync.
- `buildSnapshotPayload` reads from `snapshotStateRef` (updated render-time, NOT useEffect) to avoid stale-closure uploads of pre-mutation state.
- Concurrency: `If-Match: <serverTs>` accepted, returns 409 with current serverTs when stale. Frontend doesn't yet send it — last-write-wins preserved. Mandatory `If-Match` is deferred.
- `applySnapshot` survives because the first-device-claim **Restore card** + owner-auto-restore useEffect still need it: any cloud membership not matched to a local `groups[]` entry renders a "Restore" card → clicking pulls latest snapshot and creates the local group from `payload.meta`. The historical "Sync banner" was removed in D.4.D2 — polling supersedes it.

### Auth surface

2-tab Sign in / Sign up. Old Owner / Cloud tabs are gone.
- **`POST /api/auth/signup`** ([src/api/signup.js](src/api/signup.js)): self-serve. With group code → `provider`; matching admin code elevates to `admin`; matching `OWNER_BOOTSTRAP_CODE` Worker secret → `can_create_groups = 1` AND group code becomes optional (cold-start owner). Rate-limited 10/hr per IP.
- **`POST /api/auth/password`** looks up by email OR username (`emailOrUsername` field). Rate-limited 10/hr per (email, ip) via `password_attempts`. Passwords are PBKDF2 (310k iters, SHA-256, 16-byte salt; format `pbkdf2$310000$<salt>$<hash>`).
- **`POST /api/groups`** and **`/api/groups/:gid/migrate`** gated on `can_create_groups`. Migrate creates a cloud group + one `kind='test'` user per local user; result modal shows email + temp-password once.
- **`POST /api/users`** is the admin create-cloud-user surface. `kind='test'` mints synthetic `<localId>@<cloudGroupId>.test.invalid`; `kind='real'` pre-issues a magic link via Resend.
- **Magic link** is the fallback under "Or email me a sign-in link" (only fires when input contains `@`).
- **Forgot password** ([src/api/reset.js](src/api/reset.js)): `POST /api/auth/forgot-password` (rate-limited 5/hr per user via row count in `password_reset_tokens`; always returns 204 to prevent enumeration) → server-rendered `GET /api/auth/reset-password?token=…` form (32-byte tokens, single-use, 15-min TTL) → `POST /api/auth/reset-password` revokes other live sessions on success.
- **Self-service profile** ([src/api/profile.js](src/api/profile.js)): `PATCH /api/me/profile` (display name; frontend additionally fires `user.update` into EVERY group the caller is a member of so the per-group `users[gid][i].name` stays in sync), `POST /api/me/password` (current-password gated), `POST /api/me/change-email-request` (magic link to new address, applied via `GET /api/auth/verify-email-change` with apply-time uniqueness re-check). ProfileModal opens from sidebar chip / mobile avatar / SuperDashboard topbar. Disabled during impersonation.

### Cloud-owner bridge + impersonation

`me.role === "super"` is derived from `cloudUser.memberships.some(m => m.role === "owner") || cloudUser.user.canCreateGroups` when no local session is present. Precedence: **impersonation > local session > cloud-owner bridge** — local sign-in wins so test-user switching works mid-cloud-session. SuperDashboard's "👁 View as" → `ImpersonatePickerModal` → `startImpersonate(gid, localUid)`; state persists in `sessionStorage` under `shyft3_impersonate`. **Caveat:** events during impersonation attribute to the impersonated `localUid`.

### Accounts management

Owner-only `GET/PATCH/DELETE /api/owner/users[/:uid]` ([src/api/owner.js](src/api/owner.js)). Owner self-edits go through ProfileModal (Accounts excludes self by server-side filter). `AccountsEditModal` requires confirm-twice for email + password (typos on a password reset would otherwise lock the target user out with no recovery path).

**Delete cascades at three layers:**
- Client, currently-loaded group: `applyAndTrack("user.delete", { uid, cascadeShifts })`.
- Client, non-loaded affected groups: hand-edit localStorage so the next open sees correct state.
- Server: `patchSnapshotRemoveUser` rewrites the D1 snapshot for each affected `(group_id, local_uid)` pair (filters user out of `payload.users`, cascade-cleans `shifts` / `unavail` / `prefs` / `topOptions`) and writes a fresh R2 history entry stamped `patchedBy: "deleteOwnerUser"`. Refuses to delete a user who owns any group.

### Load-bearing quirks

- **Uid form** — see [Coding conventions](#coding-conventions) for the full rule. Strict-equality between numeric local + wire-string forms has bitten us twice (`73919da`, `a09bf4f`).
- **`block.reconcile` payload shape** — `awards` MUST be a flat array `{dateKey, slotId, uid, source, auto, bid?}`. MUST include both reconcile AND auto-assign cells (replaying devices miss auto-assigns otherwise). `auto` must be carried through per-entry — don't hardcode false. Three latent shape bugs around this were fixed in `8e2cd63`.
- **Pre-D.3 cleanup** — `shyft3_supers` localStorage key is pruned on first load via a one-shot block in `templates/shyft_head.v3.html` (marker `shyft3_migrate_prune_supers`).

---

## Token efficiency rules

This is a hobby project on a personal token budget. Follow these rules to keep iterations cheap:

**Never read the wrong files**
- **`legacy/` is off-limits.** Never Read, never grep. v1/v2 are frozen archives kept only for git history.
- **Never Read `index.html`** (the built artifact). It's regenerated by the build script and is just `head + JSX + tail` concatenated. To inspect content, Read `ShiftApp.v3.jsx` (or the head/tail templates). The *only* valid use of `index.html` is the brace-count sanity pipe.
- **Never Read `Test logins.xlsx`, `svg code for logos.docx`, or any image** unless explicitly asked. (The old `Phases for Shyft and Rules for shift assignment.docx` spec doc has been deleted from the repo — don't try to find it.)

**Read large files in slices**
- `ShiftApp.v3.jsx` is ~6300 lines. **Always grep first** to find line numbers, then Read with `offset` + `limit`.
- Same rule applies to `templates/shyft_head.v3.html` (~1100 lines) when in doubt.

**Filter your greps**
- Default include filters: `--include="*.jsx" --include="*.html" --include="*.md"`. Skips .docx/.xlsx/.png assets and the test-logins file.
- Adding `--exclude-dir=legacy` belt-and-suspenders if grepping recursively.

**Don't repeat work**
- If you greped for a symbol earlier and saw the line numbers, **don't grep for it again.** Read directly.
- After a rebuild, **don't Read the built artifact to verify.** The brace-count pipe + a targeted grep for new symbols is sufficient.

**Tool choice**
- For multi-occurrence renames, use `Edit` with `replace_all: true` (one tool call).
- Skip `TodoWrite` for ≤3-step tasks.
- Prefer `Edit` (sends the diff) over `Write` (sends the whole file) when modifying existing files.

**Keep prose tight**
- Skip long preambles ("let me check X, then Y, then Z"). Just do it.
- For design discussions, cap proposed alternatives at ~3 short bullets each.

---

## Phase state machine

Every block has a `phase` field. UI gates read-only state on this.

```
availability  →  reconciliation  →  locked
   (admin           (admin             (admin
   "Close             "Lock             "Unlock"
   & assign")         block")           reverts to recon)
```

- **availability**: providers edit availability/preferences/Top Options/bids. Pools (Top Options) accept signups.
- **reconciliation**: assignments computed and frozen. Providers confirm/flag awarded shifts. Marketplace open. Flags auto-post to the marketplace at zero incentive and surface in the admin's Flagged Shifts module for one-click swap / trade.
- **locked**: points are committed (Step 2 of build, deferred). Marketplace stays open for take-style trades. Admin adjustments allowed.

Phase constants:

```js
const PHASE = { AVAIL: "availability", RECON: "reconciliation", LOCKED: "locked" };
const phaseOf = b => (b && b.phase) || PHASE.AVAIL;
const isAvailabilityOpen = b => phaseOf(b) === PHASE.AVAIL;
const isReconciling = b => phaseOf(b) === PHASE.RECON;
const isLocked = b => phaseOf(b) === PHASE.LOCKED;
```

The "Close & assign" admin action is the big one — it runs `computeReconcile` (process Top Options, place winners, charge bids) → `computeAutoAssign` (two-pass: preferred → available) → transitions phase to `RECON` → opens the Block Report modal. All in one click.

---

## Top Option model (v3.1, current)

The most recent significant change. Replaces the v2/v3.0 "per-slot pool" model.

**Old mental model (gone):** Provider joins Primary pool OR Backup pool independently per day. Plus a separate per-day Preferred star.

**New mental model:** Each day has 4 mutually exclusive states per provider:

| State | Bid? | Auto-assign tier |
|-------|------|------------------|
| 🎯 **Top Option** | Yes (1+) | Tier 0 — wins via reconcile |
| ⭐ **Preferred** | No | Tier 1 — auto-assign first pass |
| **Available** (default) | No | Tier 2 — auto-assign second pass |
| 🚫 **Blocked** | n/a | Excluded |

When picking Top Option, the provider also chooses a **slot preference** (Primary / Backup / Either). Lenient cascade: if their preferred slot is taken by a higher bidder, they get the other open slot.

**Storage:**

```js
// Per-day commitment map
topOptions[dateKey] = {
  [uid]: { bid: number, slotPref: number|null }   // slotPref = slotId or null (Either)
}
// Per-slot entries are AWARD-ONLY — no .pool, no .bids
shifts[dateKey][slotId] = {
  uid, auto, source, confirm, flagReason, swappedFrom, takenFrom, bid?
}
```

**Key handlers (all inside ShiftApp component):**
- `setTopOption(dateKey, slotPref, bid)` / `clearTopOption(dateKey)`
- `setBid(dateKey, n)` / `setSlotPref(dateKey, slotId|null)`
- `togglePreference(k)` / `toggleUnavail(k)` (existing, with new invariants — clearing preference also clears Top Option)

**Helpers (component-local, NOT in head template):**
- `inTopOption(dateKey, uid)` → bool
- `dayTopOptionerCount(dateKey)` → int
- `getDayTopOptioners(dateKey)` → object map
- `getDayBid(dateKey, uid)` → number
- `getDaySlotPref(dateKey, uid)` → slotId|null
- `TOP_OPTION_DEFAULT_BID = 1`

A one-time migration in `loadGroup` walks any pre-existing `entry.pool` arrays and converts them to the new `topOptions` map. Marker: `shyft3_g{gid}_migrate_top_options`.

---

## Reconciliation features (Phase 3)

Three things added on top of the phase machine:

### Confirm / Flag (per awarded shift)

Each entry can carry `confirm: "ok"|"flagged"` and `flagReason: string`. Provider sees Confirm/Flag buttons on each of their awarded shifts in the **My shifts** page during Reconciliation+.

`flagShift(dateKey, slotId, reason)` marks the entry flagged + auto-posts it to the marketplace at zero incentive (so anyone can take it), then surfaces it in the admin's Flagged Shifts module. v3.2 removed the silent auto-reassign path — every flag now goes to admin review.

### Swap candidates (admin-driven)

`findSwapCandidates(dateKey, originalUid)` returns the full ranked list of eligible alternatives for the admin. Filters: not the current assignee, not blocked, not already on this day, has seniority. Ranking: preferred-date first, then `snapshotPtsForReconcile()` desc (or rotating tie-break index when the block is points-off), then lowest uid. Admin commits via `acceptSwapCandidate` → `shift.swap-admin` event. Max-cap is NOT a hard filter — at-max candidates are surfaced with an `atMax` flag so the admin can knowingly override.

### Marketplace (take + two-sided trades)

```js
marketplace[i] = {
  id, dateKey, slotId, sellerId, incentivePts,
  postedAt, status: "open"|"taken"|"cancelled",
  takenBy?, takenAt?, autoPosted?, flagReason?,
  offers?: [{ id, offererId, offererDateKey, offererSlotId, incentivePts, status }]
}
```

Producers: `postForTake`, `takeListing`, `cancelListing`, `offerTrade`, `acceptTradeOffer`, `declineTradeOffer` — all route through `applyAndTrack`; the corresponding reducers (`marketplace.post` / `.take` / `.cancel` / `trade.offer-*`) own the actual state transitions. Listings appear in the **Trades** page (in nav for both providers and admin). Open count badged on nav.

**Open-shift takes (derived, no listing).** Unfilled slots in the current block are surfaced directly in the Trades page during Recon+Locked under an "OPEN SHIFTS" section — derived from `shifts` (no marketplace listing is created), so the data stays single-sourced. Producer `takeOpenShift(dateKey, slotId)` (mirrors `takeListing`'s policy: hard 1-per-day check, blocked/max NOT enforced — the user is actively choosing) captures any `openIncentives[dateKey][slotId]` into the payload and fires `shift.take-open`. The reducer assigns the taker with `source: "marketplace"`, consumes the `openIncentives` entry, and credits the taker — same incentive-credit shape as `shift.admin-assign`. Nav badge includes open-shift count alongside marketplace listings.

### Lock-time point crediting

Base earnings (day-pts × slot-credit + non-pref bonus) credit at the **Lock** transition, not at reconcile. Reconcile still applies bid debits, availability penalties, and open-shift incentive credits immediately; earnings stay deferred until the admin locks the block.

Implementation (no new `pendingPoints` field — stamp + reverse pattern):
- **Producer** at the lock callsite builds `earnings = {uid: pts}` via `buildBlockEarnings()` (iterates providers, calls the phase-blind `computePtsEarnedRaw(uid)`). The map is included in the `block.lock` event payload.
- **`block.lock` reducer** applies the earnings to `users.points` AND stamps the exact map on the block config as `pointsCreditedAtLock`.
- **`block.unlock` reducer** reads `payload.earnings` (the unlock producer passes `currentBlock.pointsCreditedAtLock` back in) and subtracts to reverse. Same map → exact reversal, no recompute drift.
- **`block.reset` reducer** accepts a new `payload.restoredEarnings` so resetting from a locked block also reverses the credit, alongside the existing bid/penalty reversal.

To avoid double-counting in projections after lock, `getPtsEarned(uid)` returns 0 when `isLocked(currentBlock)` — earnings already live in `users.points` at that point. A phase-blind sibling `computePtsEarnedRaw(uid)` exists for the lock callsite which needs the value despite the projection going to zero.

### Per-block target snapshots (`targetsAtClose`)

At reconcile, the producer captures `targetsAtClose = {uid: {min, ideal, max}}` from current providers (min derived from `seniorityLevels.find(l => l.id === u.seniorityId)?.minShifts`, ideal/max from `u.targets`) and the `block.reconcile` reducer stamps it on the block config. Same lifecycle as `pointsAtClose` — cleared by `block.reset`. Powers the Provider Report's cross-block target summation so retargeting a provider mid-history doesn't retroactively rewrite past blocks.

### Admin reports

Two admin-only modals reachable from the dashboard's Quick Actions:

- **📊 Block report** (existing) — totals + per-provider breakdown for the active block. Per-provider table columns: Provider | Total | M/I/Mx | Top | Pref | Avail | Adm | Wknd | Spend | Proj. Source-bucket counts carry a `(P%)` suffix relative to the row's total (omitted for zeros). `Spend` is current `users.points`; `Proj` is the *not-yet-credited delta* `getPtsEarned − pendingPenalty` (pending earnings minus the AVAIL-only availability penalty). So in AVAIL it's the projected net swing through reconcile + lock; in RECON it's just the pending earnings; in LOCKED it's 0 (earnings already in `users.points`). Spend + Proj equals the projected final balance.
- **📈 Provider report** (new) — same layout aggregated over N blocks via a top-of-modal "Last N / All blocks" dropdown. Sums source buckets across selected blocks; M/I/Mx sums per-block via each block's `targetsAtClose` snapshot (falls back to current values for pre-feature blocks with an amber footnote flag). Spend (current bank) and Proj (current-block not-yet-credited delta) remain point-in-time, not summed. Selecting "Last 1 block" produces output equivalent to Block Report on the current block.

### Remaining Issues alert

A third alert type inside the admin dashboard's existing **Alerts** card, surfacing during **Reconciliation + Locked** phases when there are unfilled slots. `diagnoseOpenShifts()` walks every open `(dateKey, slotId)` and classifies each provider's state on that date into one of: `blocked` / `topOptOtherSlot` (Top-Optioned the day but won the other slot) / `preferredAtMax` / `availableAtMax` / `alreadyOnDay` / `eligible`. The per-slot row shows reasons (e.g. "3 preferred this day but are at max (Alice, Bob, Carol)") plus suggestions (manual assign one of N eligible / raise max / unblock outreach / set an incentive), with an "Open day →" button that opens the existing DaySheet for that date. Hidden in AVAIL (open slots are normal during signup).

### Flagged Shifts alert + Make open action

A fourth alert row inside **Alerts**, plus an action on the existing **Flagged shifts** recommendations module below. Both surfaces share one `flaggedAlerts` array (computed once in `AdminHome`) — Alerts shows the count + first 5 rows so the admin notices; the module below renders the full swap / trade / Clear flag / Make open UI per flag.

**Detection signal — union of two paths.** Flagged state desyncs cheaply: `shift.clear-flag` wipes `confirm` but leaves the listing, `marketplace.take` sets `confirm:null`, an admin slot-clear leaves the auto-listing orphaned. So `flaggedAlerts` unions:
- (a) shift entries with `confirm === "flagged"` and a uid (the still-live flags), and
- (b) open `marketplace` listings with `autoPosted === true` (the orange "flagged" pill on Trades — catches orphans).

Deduped by `(dateKey, slotId)`, `flagReason` coalesced from either source, `originalUid` from the shift uid when present else `listing.sellerId`. Both gated to `blockDays` so cross-block listings don't bleed in.

**Make open action.** The per-flag card has two action buttons now: "Clear flag" (existing — unflags but leaves the shift assigned) and "Make open" (new — vacates the slot, slot then appears under Trades' Open shifts). Producer `removeFlaggedShift` branches: if the shift entry has a uid, fire `shift.admin-assign` with `uid:null` (the reducer now also calls `closeAutoListingFor` so the listing-close is atomic with the slot-clear); if the entry is empty but an open auto-listing exists, fire `marketplace.cancel` directly.

The `shift.admin-assign` reducer change is the natural cleanup — a cleared slot can't have a meaningful "for sale" listing — so it benefits every admin-clear path, not just the flagged module. `closeAutoListingFor` is a no-op when no open auto-listing exists, so existing callsites are unaffected.

---

## Coding conventions

- **Single-file React, no build tools.** Babel-standalone in the browser. JSX at runtime.
- **Tailwind via CDN** with extensions for `brand-*`, `ink-*`, `canvas`, `surface`, `shadow-card`. See head template.
- **Inter font.** Stat tiles use `tabular-nums` for alignment.
- **No external state libs.** Plain `useState`. Persistence via `window.storage` (a thin localStorage wrapper).
- **Compact code, dense comments.** The codebase favors slightly-dense JSX with explanatory comments above complex blocks rather than spreading things out. Match this style.
- **Source-tag awarded entries.** When awarding a shift, set `source` to one of: `pool` | `pool-solo` | `cascade` | `preferred-auto` | `available-auto` | `auto-swap` | `marketplace` | `admin`. The block report attributes by source.
- **Determinism for `applyEvent`.** Anything inside an `EVENT_HANDLERS` branch must be pure — no `Date.now()`, no `Math.random()`, no clock reads. If a handler needs entropy or a timestamp, the producer in `ShiftApp.v3.jsx` must capture it into the event payload (see D.4.B's `chainRepair`, `listing`, `awarded` enrichments).
- **New mutations go through `applyAndTrack`.** Every state mutation flows `applyAndTrack(type, payload, opts)` → reducer → `setX + persist + POST`. Add a handler to `EVENT_HANDLERS` in the head template (mirror a reference stub `(s, e) => s` in the JSX preamble's `EVENT_HANDLERS` block — the whole reducer family in the preamble is stubs-only, see [head-template sync](#-critical-gotcha-head-template-sync)). Capture non-deterministic inputs into payload; the producer just does eligibility checks + `await applyAndTrack(...)`. No direct `setX + persist` in handlers. For cascades that touch multiple slices, design the reducer to do all of them; `applyAndTrack`'s object-identity diff dispatches only the slices that actually changed.
- **Uid form: numeric local, stringified on the wire.** Local `users[i].id` is numeric; `me.id` and `entry.uid` in `shifts` are numeric. The wire format stringifies uids (`fromUid: String(me.id)`, etc.) for forward-compat with cloud-uuid uids someday. The reducer normalizes via `uidVal(...)` when writing into numeric-keyed fields (shifts[].uid, marketplace .offererId, .takenBy). For cross-source comparisons, always use the `eqId(a, b)` helper (canonical copy in head template near `uidVal`, mirror in JSX preamble) — strict-equality between numeric local and wire-string forms has bitten us twice already (`73919da`, `a09bf4f`). `eqId` also returns false for null/null, so it doubles as a "set & equal" check.
- **Per-block points-mode gating.** `block.usePoints` is the per-block flag (no group-level setting — that was added then explicitly removed during design as too friction-y). `currentBlockHasPoints` derives the boolean. Most UI gating cascades automatically through source helpers: `getPtsEarned` and `getAvailInfo.penalty` short-circuit to 0 in points-off mode, so any render that gates on `> 0` naturally hides. Reach for direct render gating on `currentBlockHasPoints` only when a control is a points-only concept (bid inputs, incentive steppers, Spend/Proj columns).
- **Producer-driven payloads with zero/empty defaults.** For toggle-able behaviors (the points-off mode is the worked example), default the producer to emit zeros / empties (`bid: 0`, `incentivePts: 0`, `availPenalties: {}`, `earnings: {}`); existing reducers naturally no-op the `+=` / no-op the cascade. Only touch reducers when storing a new state shape — e.g., `block.reconcile` stamping `tieBreakOrder` on the block via `patchBlockInConfig` when the payload includes it (omitted in points-on mode, so it's a no-op there).
- **Rotating tie-break: producer-side mutation, reducer-passive stamping.** `buildTieBreakWorkingOrder(block)` builds a fresh working copy (self-heals: drops removed uids, appends new ones at end). Producers mutate it in place as winners commit (rotation = remove + push to end) and emit the final order in the event payload. `computeReconcile` and `computeAutoAssign` thread a shared `workingOrder` through both phases of "Close & assign" so the queue advances continuously across reconcile + auto-assign. Reducer just stamps via `patchBlockInConfig` — no `Math.random` inside.
- **No emojis in code unless they're already part of the UX vocabulary** (🎯 ⭐ ✕ ⚙ 📣). User explicitly favors emoji UI for state markers.

---

## What's done / what's pending

### Done in v3
- ✅ Phase state machine (availability/reconciliation/locked) with admin transitions
- ✅ One-time migration from v2
- ✅ "Close & assign" combined action (reconcile + auto-assign + phase advance + report)
- ✅ Confirm/Flag UI on My Shifts
- ✅ Auto-swap engine on flag
- ✅ Take-style marketplace + Trades page + nav badge
- ✅ Two-sided trades (post-offer / accept / decline)
- ✅ Admin-added incentive points on open shifts (`openIncentives` slice)
- ✅ Provider pages split into **Preferences** (📅 the old SchedulePage — editable per-day Top Option / Preferred / Available / Blocked; in Recon+ the overlays + bid summary stay visible but the controls are locked) and **Schedule** (📅 new — assignments-focused calendar/list, mostly empty in Avail, shows winners + a 🔄 per-slot badge for open marketplace listings in Recon+). Calendar view shared via `CalendarView`; per-page list views are `PreferencesList` + `AssignmentsList`.
- ✅ Lock/Unlock confirm modals
- ✅ Block report (source-bucketed per-provider counts)
- ✅ Alerts module on admin dashboard
- ✅ **v3.1: Top Option model replacing per-slot pools**
- ✅ Phase A backend: magic-link auth, owner-issued invites (Cloudflare Worker + D1 + R2)
- ✅ Phase B event log (`POST /api/events` + 26 wired types)
- ✅ Phase C snapshot sync (debounced upload + Restore card; sync banner deleted in D.4.D2 Phase 5)
- ✅ Phase D.1/D.2/D.2.5: password auth, one-shot migration, cloud-owner bridge + impersonation
- ✅ Phase D.3: cloud-backed signup + sign in, owner Accounts page
- ✅ Phase D.4.A: backend foundation (allow-list, `GET /api/events` tail, payload-size bump)
- ✅ Phase D.4.B: full `trackEvent` coverage + payload enrichments
- ✅ Phase D.4.C: `applyEvent` reducer + offline validator
- ✅ Phase D.4.D1: dual-write shadow diff + event outbox
- ✅ Phase D.4.D2: cloud-authoritative cutover (6 sub-phases — `loadGroup` cloud-first, 15s poll, per-tab client id, mutation refactor through `applyAndTrack`, snapshot uploader demotion, sync banner removal)
- ✅ Lock-time point crediting: base earnings credit at lock via `block.lock` reducer; stamped `pointsCreditedAtLock` map enables exact reversal at unlock/reset; `getPtsEarned` phase-aware to avoid double-counting
- ✅ Per-block target snapshots (`targetsAtClose`) — powers Provider Report's accurate cross-block target sums
- ✅ Provider report: cross-block aggregate of Block Report (Last N / All blocks selector)
- ✅ Block report enhancements: Wknd, Spend, Proj columns + per-source percentages
- ✅ Remaining Issues alert: per-open-slot diagnosis + suggestions during RECON/LOCKED
- ✅ Self-service Profile modal (display name / email-via-magic-link / password-with-current-password) — `src/api/profile.js` + migration 0006. Opens from sidebar chip, mobile avatar, and owner SuperDashboard topbar.
- ✅ Forgot-password flow on sign-in screen — `src/api/reset.js` + migration 0007. Server-rendered set-new-password form, single-use 15-min tokens, rate-limited.
- ✅ AccountsEditModal confirm-twice for email + password.
- ✅ Provider Report linked from the admin sidebar (📈) as a nav item that opens the existing modal.
- ✅ Apex (`shift-scheduling.com`) + www both serve directly with shared cookies (`Domain=shift-scheduling.com`); no apex→www 301.
- ✅ Open-shift takes in Trades: `shift.take-open` event + reducer + `takeOpenShift` producer; derived "OPEN SHIFTS" section in Trades during Recon+Locked, with the day's `openIncentives` credit transferred on take.
- ✅ Recon/Locked calendar shading: filled days use `bg-blue-50` (Recon) / `bg-emerald-50` (Locked) instead of the orange "Available" shading; orange in non-Availability now means "still has an open slot". Phase-aware legend hides Preferred/Top Option/Blocked entries outside Availability.
- ✅ Hard-to-fill (admin ⚠) now fires on any unfilled slot in-block post-Availability — not just the original "all-auto + nobody preferred + ≥50% blocked" coverage rule. Gated to in-block dates.
- ✅ Block / Provider Report `Proj` column shows the not-yet-credited delta (`getPtsEarned − pendingPenalty`) instead of bank + delta — so Spend + Proj = projected final balance; Proj goes to 0 once the block is locked.
- ✅ Flagged Shifts alert on the admin dashboard + "Make open" action on the Flagged shifts module. Detection signal is the union of `entry.confirm === "flagged"` AND open `marketplace.autoPosted` listings (catches orphan listings where the shift was reassigned/cleared but the auto-listing lingered). `shift.admin-assign` reducer with `uid:null` now also calls `closeAutoListingFor` so slot-clear and listing-close are atomic.
- ✅ **Per-block no-points mode** — admin picks at block-create whether the block uses the points system. Off → Top Options become binary (no bid), tie-breaks rotate via a per-block randomized queue (`block.tieBreakOrder`, Fisher–Yates at create, winner-to-back rotation through reconcile + auto-assign + admin swaps, self-heals to current providers), trades become pure swaps (incentive = 0), no earnings credit at lock, no availability penalties — violations surface as alerts only. Schema lives on each block (`block.usePoints` + `block.tieBreakOrder`); no group-level setting. `currentBlockHasPoints` derived helper gates UI; source-helper gating on `getPtsEarned` and `getAvailInfo.penalty` cascades to ~15 surfaces without per-render conditionals. Existing `users.points` balances are preserved as dead data (not zeroed) when a group flips off, so flipping back resumes seamlessly. Implementation conventions:
  - **Producer-driven payloads, reducer-passive.** Most points-off behavior emerges from producers sending zeros / empties (`bid: 0`, `incentivePts: 0`, `availPenalties: {}`, `earnings: {}`). Existing reducers no-op the += naturally. Only two reducers needed updates: `block.reconcile` and `shift.swap-admin` now stamp `tieBreakOrder` on the block via `patchBlockInConfig` when the payload includes it (omitted in points-on, so it's a no-op there).
  - **Rotating tie-break is producer-side.** `buildTieBreakWorkingOrder(block)` builds a fresh working copy; `computeReconcile(workingOrder)` and `computeAutoAssign(startingShifts, workingOrder)` mutate it in place and return it via `tieBreakOrder` in their results. `applyReconcile` chains them and emits the final order in payload. `acceptSwapCandidate` rotates the picked uid and includes the updated order in the `shift.swap-admin` payload. Reducer is pure — no `Math.random` inside.
  - **Backwards compat.** Missing `block.usePoints` → `true`. Missing `block.tieBreakOrder` → empty / built fresh on demand. Pre-feature events replay cleanly.
  - **Per-block flag, not group.** The mode is locked at block-create; flipping later would require creating a new block. No `config.usePoints` group setting (was added then removed during design — friction was too high; defaulting to the most-recently-created block's mode covers the "remember my preference" use case).
  - **"Alerts not penalties" UX rule.** Threshold checks (`prefMeets` / `blockMeets`) still drive the ProviderHome "Availability requirements not met" banner, the Preferences Status Report card, and the admin Dashboard `failingAvail` row in BOTH modes — the only thing that changes is the point-cost copy.
- ✅ Setup Holidays list filters to dates inside the current block (with an italic hint showing the hidden count). Old holidays from prior blocks stop cluttering. Filter no-ops when no current block exists (fresh group can still pre-configure).
- ✅ **Weekend balance in auto-assign + admin swap** — on weekend dates, the preferred and available passes prefer providers with fewer cumulative weekend shifts. `computeAutoAssign` seeds a `liveWeekend[uid]` map from `result[]` (so all historical weekends across blocks + any Top Option weekends just reconciled count) and inserts a sort tier between "below-ideal" and the generic `liveCount` fairness fallback; bumps on commit alongside `liveCount`/`liveDates`. `findSwapCandidates` mirrors the pattern, with the weekend tier sitting just below "preferred" and above the points/rotation tiebreak. Applies in both points and points-off modes. Top Options stay bid-based (no weekend tier inserted in `computeReconcile`) — the user opted in via bid. Cross-block by construction since `shifts` is keyed by dateKey without block scoping.
- ✅ **Opt-in "Large text" accessibility toggle** — per-device readability boost surfaced as a checkbox in ProfileModal's new Appearance section. Persisted at `localStorage.shyft3_large_text`; applied via `data-large-text="1"` on `<html>`. Two CSS rules in the head template's `<style>` block bump `text-[10px]` and `text-[11px]` arbitrary classes to 12px (specificity 0,2,1 beats Tailwind's 0,1,0 — no `!important` needed). A pre-render IIFE in the head template reads localStorage and sets the attribute before React mounts, avoiding a flash of small text on reload. `window.__getLargeText` / `window.__setLargeText` are the imperative handles; the JSX side mirrors via a `largeText` useState. **Convention impact:** new sub-12px text should use the arbitrary `text-[Npx]` form (or just `text-xs`) so the override catches it. Default users are unaffected.

### Pending (deferred by user)
- ⏳ Schedule snapshot at Lock (frozen "My final schedule" view per user, persisted with the block).
- ⏳ Lingering D.4.E follow-up: several entity ids still mint with `Date.now()` instead of `crypto.randomUUID()` (which is what listings, offers, and event ids moved to in `e355615`). Same-millisecond collision is rare but real — most pressing for ids that cross device boundaries via the event log. Concrete spots (line numbers drift as the file evolves; grep `id:\s*Date\.now\(\)` if these don't resolve):
  - **`user.id`** in `adminAddUser` ([ShiftApp.v3.jsx:2946](ShiftApp.v3.jsx:2946)). Migrating breaks the "numeric local uid" convention — revisit when cloud-uuid uids are adopted more broadly.
  - **`groups.id`** at five local-group-creation callsites ([ShiftApp.v3.jsx:694](ShiftApp.v3.jsx:694), [724](ShiftApp.v3.jsx:724), [1181](ShiftApp.v3.jsx:1181), [1418](ShiftApp.v3.jsx:1418), [1627](ShiftApp.v3.jsx:1627)). Local-only ids, low collision risk. Note 1181 already adds `+ Math.floor(Math.random()*1000)` as a mitigation in the owner-restore path.
  - **`config.blocks[].id`** at [ShiftApp.v3.jsx:516](ShiftApp.v3.jsx:516) (legacy single-block migration) and [5497](ShiftApp.v3.jsx:5497) ("+ New block" admin button). Block ids cross devices via `config.update` events — two admins creating a block in the same millisecond would collide.
  - **`config.shiftSlots[].id`** at [ShiftApp.v3.jsx:5577](ShiftApp.v3.jsx:5577) and **`config.seniorityLevels[].id`** at [ShiftApp.v3.jsx:5594](ShiftApp.v3.jsx:5594) — same cross-device caveat as block ids.
- ⏳ R2 monthly event-log archival (deferred until corpus grows).
- ⏳ Mandatory `If-Match` on snapshot uploads (concurrency control beyond last-write-wins).
- ⏳ **Low priority** — retire stale one-shot migrations baked into the load path. Each is currently correct (idempotent + marker-gated in localStorage) and has run on every existing user's device, but they accumulate as load-time overhead and noise in `loadGroup`/the head template. Worth declaring a "post-D.3 baseline" someday and dropping them all. Spots:
  - `shyft3_migrate_from_v2` ([templates/shyft_head.v3.html:104](templates/shyft_head.v3.html:104)) — v2→v3 storage import.
  - `shyft3_migrate_prune_supers` (head template) — pre-D.3 super-bootstrap key cleanup.
  - `shyft3_g{gid}_migrate_top_options` (in `loadGroup`) — per-group pool→topOptions conversion.
  - Inline `pointValuesLocked` defaulting + legacy `blockStart/blockEnd/signupOpen → blocks[]` migrations inside `loadGroup`'s config branch.

---

## Verification quick reference

Build + brace check:

```bash
# Run from the project root (the folder that contains ShiftApp.v3.jsx and templates/).
N=$(grep -n "^export default function ShiftApp" ShiftApp.v3.jsx | cut -d: -f1)
{ cat templates/shyft_head.v3.html; tail -n +"$N" ShiftApp.v3.jsx | sed 's/^export default function ShiftApp/function ShiftApp/'; cat templates/shyft_tail.v3.html; } > index.html
o=$(grep -o '{' index.html | wc -l) && c=$(grep -o '}' index.html | wc -l) && echo "braces $o/$c"
```

**⚠ Opening `index.html` from `file://` no longer works post-D.3.** All sign-in paths go through the Worker (`/api/auth/password`, `/api/auth/signup`, `/api/me`), so the auth screen loads but has no way to authenticate without the backend running. Use one of:

- **`npx wrangler dev --remote`** — runs the Worker at `http://localhost:8787` but proxies D1, R2, and secrets to the deployed instances. Real cloud auth, real event log, no production deploy needed. Lowest friction for local smoke testing.
- **`npx wrangler deploy`** — full production push to `www.shift-scheduling.com`. Use when you're ready to soak against real traffic, or when testing something that only manifests in production (e.g. cookie-domain edge cases, custom-domain CSRF).

Smoke test (against either of the above):
1. Sign in as admin → Setup → create a block in Availability phase
2. Sign in as provider → Schedule → tap a day → 🎯 Top Option → bid + slot pref
3. Repeat for a few providers, some contested
4. Admin → Close & assign → verify report shows pool/cascade/auto rows
5. Provider → Mine → confirm one shift, flag another (try both auto-swap and no-candidate paths)
6. Trades page → take a listed shift as another provider
7. Admin → Lock block

D.4 verification (cloud-signed-in owner only):
- **Validator is the canonical source-of-truth check.** Run `await window.__shiftValidator.run()` in DevTools; expect `✅ 0 divergences`. (The historical shadow-diff inside `trackEvent` is gone — that whole helper was removed for being dead code; divergence detection lives only in the validator now.)
- **Console should stay quiet.** Any `[applyAndTrack] reducer threw`, `[uploadSnapshot] refusing…`, `[uploadSnapshot] POST failed`, `[loadGroupFromCloud] reverse-sync push failed`, or `[writeGroupStateToStorage] refusing…` line is worth investigating. The first one is a real bug; the others are environmental (cloud down, payload empty, etc.) and the app falls through safely, but a sustained run of them means something's wrong.
- **Cross-device:** open two windows as different users; mutate in one → other reflects within ~15s via poll. No amber Sync banner — it was removed in Phase 5.
- **Multi-window same-user:** two tabs of the same login should sync via the per-tab `SHYFT_CLIENT_ID` filter (`window.__shyftClientId` should differ per tab).
- **Snapshot uploader cadence:** mutate → `POST /api/events` fires immediately → `POST /api/snapshots` debounces for 30s then fires once. No further snapshot POSTs if no mutations.
- **Outbox check:** DevTools → Network → Offline → fire one event → Online → confirm `localStorage.getItem("shyft3_evt_outbox") === "[]"` after the flush. D.4.E adds: an amber "📭 N queued · syncing…" badge appears top-right while the outbox is non-empty (click to force-flush); a toast fires on first-queued ("📭 Saved locally") and another on full-flush ("✅ Synced"); a 4xx server reject triggers a "⚠ Server rejected" toast directly from applyAndTrack.
- **Cold-load:** clear localStorage → reload → sign in → group rehydrates from snapshot + event-tail replay via `loadGroupFromCloud`.

---

## Working with the user (David)

- Prefers conversational design discussions before implementation. When proposing a change with multiple valid approaches, surface 2–3 alternatives.
- Builds incrementally. Each step should produce a working artifact.
- Wants the UI to remain simple for end users. Prefers consolidating duplicate concepts over adding more controls.
- Single-file React + Tailwind + babel-standalone is non-negotiable. Don't introduce a build tool.
- Task tracking (`TaskCreate` / `TaskUpdate`) is welcome for multi-step features. Skip it for trivial changes.
- Plan mode is welcome for significant architectural changes — user often initiates with "go in to plan mode."
