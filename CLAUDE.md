# SHIFT — Claude Code project notes

The product is **SHIFT Scheduling** (call it **SHIFT** for short) — a scheduling application **for medical professionals**. Providers sign up for / bid on shifts, an admin reconciles, a marketplace handles last-minute trades. Built around a phased lifecycle (availability → reconciliation → locked) with a points-based priority system.

This file is the catch-up brief for Claude Code instances joining the project mid-stream. **Read it first** before exploring code — the architecture has a few non-obvious gotchas that will burn time if you discover them by accident.

> **Naming note for Claude:** the codebase predates the rebrand and still uses **`shyft`** in technical identifiers — file names (`ShiftApp.v3.jsx`, `shyft-v3.html`, `templates/shyft_head.v3.html`), the localStorage namespace (`shyft3_*`), and the migration markers (`shyft3_migrate_from_v2`, `shyft3_g{gid}_migrate_top_options`). **Leave these alone.** Renaming the storage namespace would invalidate every existing user's data. Only update brand mentions in user-facing UI strings, comments, and docs. (The old `SUPER_BOOTSTRAP = "Shyft-Kai-Dave"` constant moved to a Worker secret, `OWNER_BOOTSTRAP_CODE`, in D.3 — same value, different home.)

---

## Product principles

The interface must be **clean, professional, simple, and intuitive.** This is the audience's standing requirement — medical professionals don't have time to learn a complex tool, and the UI carries the credibility of the product. When in doubt, simplify. When asked between "more powerful" and "easier to understand," pick easier. Recent design moves (e.g. the v3.1 collapse from per-slot pools + per-day preference into a single 4-state Top Option model) are worked examples of this principle.

## Project scope & constraints

- **Hobby project.** David is building this on his own time. Recurring costs ≈ $0 — Cloudflare's free tier covers Workers, D1, and R2 at our current scale. No paid SaaS, no per-seat licenses. Flag anything that would change that.
- **localStorage is still authoritative; cloud mirrors.** Phases A–C added cloud auth + event log + snapshot sync; Phase D is the in-flight migration to make cloud the source of truth. Until D.4.D2 ships, every state mutation writes to localStorage first; the event log + snapshot uploads run in parallel.
- **Hosted as a website.** Deployed to Cloudflare Pages + Worker at `app.shift-scheduling.com`.
- **Design for cloud-mirroring from day one.** New mutations should fire `trackEvent` and the data shape should pass cleanly through `applyEvent` so the eventual D.4.D2 cutover stays cheap.

---

## Active version: v3 (with v3.1 simplification)

Only v3 is active. v1 and v2 are archived under `legacy/`.

| Version | Source | Built artifact | Status |
|---------|--------|----------------|--------|
| v1 | `legacy/ShiftApp.jsx` | `legacy/shyft.html` | Frozen archive — do not read |
| v2 | `legacy/ShiftApp.v2.jsx` | `legacy/shyft-v2.html` | Frozen archive — do not read |
| **v3** | **`ShiftApp.v3.jsx`** | **`shyft-v3.html`** | **Active — all new work goes here** |

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
shyft-v3.html
```

Build command — run from the project root (the folder that contains `ShiftApp.v3.jsx` and `templates/`):

```bash
N=$(grep -n "^export default function ShiftApp" ShiftApp.v3.jsx | cut -d: -f1)
{ cat templates/shyft_head.v3.html
  tail -n +"$N" ShiftApp.v3.jsx | sed 's/^export default function ShiftApp/function ShiftApp/'
  cat templates/shyft_tail.v3.html
} > shyft-v3.html
```

After every build, sanity-check braces:

```bash
o=$(grep -o '{' shyft-v3.html | wc -l) && c=$(grep -o '}' shyft-v3.html | wc -l) && echo "$o/$c"
```

If they don't match, you have a syntax error.

### ⚠ Critical gotcha: head-template sync

**Lines 1–96 of `ShiftApp.v3.jsx` (everything before `export default function ShiftApp`) are reference-only.** They exist for IDE readability but are **never** in the runtime build — the `tail -n +N` strips them.

The actual runtime constants live in `templates/shyft_head.v3.html`. **If you change a module-scope constant or helper in the JSX preamble, you MUST mirror the change in the head template, or it won't take effect.**

Common things that need both updates:
- `DEFAULT_CONFIG`
- `PHASE`, `PHASE_LABEL`, `PHASE_DESC`, `PHASE_TONE`
- `phaseOf`, `isAvailabilityOpen`, `isReconciling`, `isLocked`
- `getUid`, `isAuto`, `getSource`
- `currentBlockOf`, `inBlock`
- `applyEvent` + `EVENT_HANDLERS` + `diffState` (D.4.C reducer family)
- Date helpers, color tables, etc.

Component-local helpers (anything inside `function ShiftApp(...)`) only need updating in the JSX — they're inside the slice that gets included.

---

## File map

| Path | Role |
|------|------|
| `ShiftApp.v3.jsx` | Source of truth for all v3 code. Edit this. |
| `templates/shyft_head.v3.html` | Runtime preamble (DOCTYPE, Tailwind config, migration, module-scope helpers, `applyEvent` reducer). Mirror module-scope code here. |
| `templates/shyft_tail.v3.html` | Runtime postamble. Just `<ReactDOM>.render()`. Don't touch. |
| `shyft-v3.html` | Built artifact. **Never edit by hand** — gets overwritten. Cloudflare Pages serves this. |
| `index.html` | Tiny redirect to `shyft-v3.html` so the root URL of the deployed site loads the app. |
| `wrangler.jsonc` | Cloudflare Worker config. Binds the API Worker (`_worker.js`), D1 (`DB`), and R2 (`R2`). |
| `_worker.js` | Worker entrypoint. Routes `/api/*` to the API; everything else falls through to static assets via `env.ASSETS.fetch`. |
| `src/api/` | API handlers + `router.js`. Modules: `auth`, `signup`, `users`, `groups`, `owner`, `events`, `snapshots`. |
| `src/lib/` | Backend helpers (`db`, `session`, `cookies`, `email`, `csrf`, `ids`, `ratelimit`, `http`). |
| `migrations/0001_init.sql` | D1 schema for Phase A: `users`, `groups`, `memberships`, `invites`, `login_tokens`, `sessions`. |
| `migrations/0002_events.sql` | Phase B append-only event log (`events` table). |
| `migrations/0003_snapshots.sql` | Phase C per-group state snapshot (`snapshots` table). Latest only — full history lives in R2. |
| `migrations/0004_users_passwords.sql` | Phase D.1: adds `users.password_hash`, `users.kind`, and `password_attempts` rate-limit table. |
| `migrations/0005_username_owner.sql` | Phase D.3: adds `users.username` (partial unique), `users.can_create_groups`, `groups.group_code`, `groups.admin_code`, plus `signup_attempts`. Backfills owner permission + group/admin codes from snapshots. |
| `Phases for Shyft and Rules for shift assignment.docx` | The spec. Source of truth for behavior. Re-read when in doubt. |
| `legacy/` | Archived v1/v2 source + built HTML, plus v1-era assignment-algorithm simulators. **Do not read or grep into.** |
| `~/.claude/plans/*.md` | Planning artifacts. Look for the most recent one for context on the latest change. |

---

## Backend (Phase A → D.4.D1, all shipped)

The Cloudflare Worker fronts a D1 database + R2 bucket. localStorage is still the source of truth in the app; the cloud mirror runs in parallel until D.4.D2 inverts the relationship.

- **Deploy:** `npx wrangler deploy` (after `wrangler login`, `d1 create shift-db`, paste id into `wrangler.jsonc`, run each `migrations/000*.sql` file via `d1 execute shift-db --remote --file=…`, `r2 bucket create shift-events`, and `wrangler secret put RESEND_API_KEY`, `SESSION_PEPPER`, `OWNER_BOOTSTRAP_CODE`).
- **Local dev:** `npx wrangler dev`. Create `.dev.vars` (gitignored) with `RESEND_API_KEY=...` and `DEV_EMAIL=console` to log magic links instead of sending.
- **Email sender:** custom domain is live (`app.shift-scheduling.com` via Resend). `EMAIL_FROM` is configured; magic links deliver to any address.
- **CSRF:** every state-changing API call must send `X-Requested-With: shift`. The `window.api.fetchJSON` shim in `templates/shyft_head.v3.html` adds it automatically.
- **Sessions:** opaque `shift_sid` cookie. Server stores `SHA-256(SESSION_PEPPER + raw)`; raw value never persisted.
- **Deploy hygiene.** The Worker's `assets.directory` is `./` (worktree root), so anything not excluded by `.assetsignore` ships as a public asset. Current `.assetsignore` excludes `*.sql`, `*.sqlite*`, `.git`, `.git/`, `.dev.vars`, `src/`, `migrations/`, etc. Before any deploy, sanity-check what `wrangler deploy` reports as new uploads.

### Phase B — append-only event log

Every meaningful state mutation fires `POST /api/events` to D1. The component-local helper `trackEvent(type, payload, opts?)` in `ShiftApp.v3.jsx` is the only call surface. The Worker rejects unknown types — to add a new event type, append it to `ALLOWED_TYPES` in `src/api/events.js` first. 26 wired types currently — see D.4.A/B subsections below for the full list. R2 archival of the event log is deferred — D1 is queryable directly and we'll dump monthly archives only when the corpus gets large enough to need it.

### Phase C — snapshot sync

After every per-group `persist()`, a debounced uploader (~2s) fires `POST /api/snapshots` with the entire per-group state plus the local-only group metadata (`groupCode`, `adminCode`, `name`, `createdAt`). D1 stores the latest (one row per group, last-write-wins); R2 stores history at `snapshots/<groupId>/<server_ts>-<client_ts>.json`. Two consumer flows:

- **Sync banner.** When a cloud-signed-in user opens a cloud-mirrored group and `checkCloudSyncOffer` sees cloud is meaningfully newer than this device's `shyft3_g<gid>_lastModified`, an amber banner offers "Sync now" — `applySnapshot` overwrites the 8 per-group keys and reloads the group.
- **First-device-claim.** On the auth screen, any cloud membership not matched to a local `groups[]` entry renders a "Restore" card; clicking it pulls the latest snapshot and creates the local group from `payload.meta`.

`buildSnapshotPayload` reads from a `snapshotStateRef` updated render-time (not via useEffect). This fixes a stale-closure bug where the 2s debounced upload was uploading pre-mutation state — caught by D.4.C's validator.

**Concurrency control.** `POST /api/snapshots` accepts `If-Match: <serverTs>` and returns 409 with the current serverTs when stale. The frontend doesn't yet send `If-Match` — backwards-compatible last-write-wins is preserved. Making it mandatory remains deferred.

### Phase D — backend-as-truth (D.1 + D.2 + D.2.5 + D.3 + D.4.A + D.4.B + D.4.C + D.4.D1 shipped)

**D.1 (password auth + cloud user creation).** PBKDF2 password hashes on `users` (310k iters, SHA-256, 16-byte salt; format `pbkdf2$310000$<salt>$<hash>`) and a `kind ∈ ('real','test')` designator. `POST /api/auth/password` issues a session for email+password, rate-limited 10/hr per (email, ip) via `password_attempts`. `POST /api/users` is the admin create-cloud-user surface: `kind='test'` mints a synthetic `<localId>@<cloudGroupId>.test.invalid` email + temp password; `kind='real'` pre-issues a magic link via Resend. The "+ Add user" modal in PeoplePage wires both flows; `NewUserInfoModal` surfaces local + cloud credentials in separate panels.

**D.2 (one-shot migration).** `POST /api/groups/:gid/migrate` creates a cloud group, marks the caller `owner`, creates one `kind='test'` user per local user, and uploads the supplied snapshot to D1 + R2. SuperDashboard renders a "Migrate to cloud" button on local-only groups; the result modal shows the email+temp-password for each migrated user (only once).

**D.2.5 (cloud-owner bridge + owner impersonation).**

- **Cloud-owner bridge.** The `me` useMemo derives `me.role === "super"` from `cloudUser.memberships.some(m => m.role === "owner") || cloudUser.user.canCreateGroups` when no local session is present. Precedence: impersonation > local session > cloud-owner bridge — local sign-in always wins so test-user switching works mid-cloud-session.
- **Owner impersonation.** SuperDashboard's "👁 View as" button → `ImpersonatePickerModal` lists admins+providers for that group (read directly from localStorage via `readGroupKey`, no group-load required) → `startImpersonate(gid, localUid)` awaits `loadGroup` then sets the `impersonate` state. State `{groupId, localUid}` persists in `sessionStorage` under `shyft3_impersonate`. An amber sticky banner shows "👤 Impersonating <name> · Stop" while active. **Caveat:** events during impersonation attribute to the impersonated `localUid`. Acceptable for test groups; revisit when real providers are using the app.

**D.3 (cloud-backed auth).** Local Sign in / Sign up are gone; their replacements are cloud-backed on a 2-tab auth screen. Migration `0005_username_owner.sql` adds `users.username` (nullable, unique-when-not-null partial index), `users.can_create_groups`, `groups.group_code`, `groups.admin_code`, plus `signup_attempts`. Grandfathers existing owners (`can_create_groups = 1` for everyone with an `owner` membership), backfills `groups.group_code` / `admin_code` from the latest snapshot's `payload.meta`.

- **`POST /api/auth/signup`** ([src/api/signup.js](src/api/signup.js)): self-serve. `{ displayName, email, username, password, groupCode?, adminCode?, ownerCode? }`. Owner code matched against `OWNER_BOOTSTRAP_CODE` Worker secret; valid → `can_create_groups = 1` AND group code becomes optional (cold-start owner). With a group code → `provider`; matching admin code elevates to `admin`. Rate-limited 10/hr per IP.
- **`POST /api/auth/password`** looks up by `email OR username` (single `emailOrUsername` field; legacy `email` alias still accepted). Response includes `username` and `canCreateGroups`.
- **`POST /api/groups`** and **`POST /api/groups/:gid/migrate`** are gated on `can_create_groups`; both persist `group_code` and `admin_code` on the row.
- **`OWNER_BOOTSTRAP_CODE`** secret currently `Shyft-Kai-Dave`. Set via `wrangler secret put` and in `.dev.vars` for local dev.

Frontend changes:

- Auth screen has 2 tabs (Sign in / Sign up); the old Owner and Cloud tabs are gone.
- Sign in: single "Email or username" + password + "Or email me a sign-in link instead" (magic-link fallback only fires when the input contains `@`).
- Sign up: name + email + username + password + group code + admin code + owner code. Group code required unless owner code is present.
- **`enterGroupAsCloudMember`** is the post-auth navigation helper for non-owner roles: pulls the latest snapshot, inserts local `groups[]` + `users[gid][i]` entries tagged with `cloudUserId`, and sets `session` so `me` resolves. Owners are a no-op (cloud bridge handles them).
- The unified `signOut` revokes the cloud session AND clears local + impersonation state.
- Pre-D.3 `shyft3_supers` localStorage key is pruned on first load via a one-shot block in `templates/shyft_head.v3.html` (marker `shyft3_migrate_prune_supers`).

**Accounts management.** Owner-only surface in SuperDashboard (top-right "Accounts" button). [src/api/owner.js](src/api/owner.js) exposes:
- `GET /api/owner/users` — lists users in caller's owned groups (self excluded, memberships rolled up).
- `PATCH /api/owner/users/:uid` — change email and/or password (rejects self-edit, email collisions, short passwords).
- `DELETE /api/owner/users/:uid` — drops memberships in caller's owned groups; if no memberships remain anywhere, fully tombstones (anonymizes email/display_name, NULLs username + password_hash, deletes sessions + login_tokens + password_attempts). Refuses to delete a user who owns any group.

Frontend: `AccountsModal` lists users with kind/magic-link badges + (group, role) chips; `AccountsEditModal` and `AccountsDeleteModal` are the action surfaces.

**D.4.A (backend foundation).** Allow-listed 13 event types in [src/api/events.js](src/api/events.js): the 12 wired in D.4.B (`user.create`, `user.update`, `user.delete`, `block.reset`, `shift.swap-admin`, `shift.trade-admin`, `trade.offer-post`, `trade.offer-accept`, `trade.offer-decline`, `incentive.open-set`, `config.update`, `unavail.reason`) plus a `snapshot.bootstrap` placeholder. `POST /api/events` now returns `{ id, serverTs }` (via `INSERT … RETURNING server_ts`). `MAX_PAYLOAD_BYTES` 16K → 64K to absorb cascade payloads. New `GET /api/events?gid=&since=&limit=&type=` paginated event tail (default 500, max 2000, soft 512 KB cap), ordered `(server_ts ASC, id ASC)`. **Consumers MUST dedupe by event `id`** because `server_ts` is second-granularity and several events can share a tick. `nextCursor` is the last returned `serverTs` (inclusive).

**D.4.B (event payload wiring).** Wires the 12 new event types into the frontend and enriches several payloads:
- `block.reconcile` carries `awarded` / `cleared` / `pointsDeltas` / `availPenalties` / `pointsAtClose` / `openIncentivesPatch` so the reducer doesn't have to re-derive the cascade.
- `topOption.clear` and `topOption.unlink` carry `chainRepair` so the reducer can replay a chain split without `Math.random`.
- `shift.flag` carries the auto-posted `listing` (created or pre-existing) so the reducer can replay the marketplace side effect.

All 26 mutation paths in `ShiftApp.v3.jsx` now fire `trackEvent`, so the D1 event log is a complete record of state changes.

**D.4.C (applyEvent reducer + offline validator).** Pure-function reducer (`applyEvent(state, evt)` in `templates/shyft_head.v3.html`, mirrored reference-only in the JSX preamble) maps each of the 26 event types onto a state transition. Deterministic: no `Date.now()`, no `Math.random()`, no clock reads — all stamping data either lives in payload (D.4.B's enrichments) or is derived from existing state. Idempotency via a FIFO `appliedEventIds` ring (cap 200). Unknown event types are forward-compat no-ops. Validator: `window.__shiftValidator.run()` (cloud-owner only) pulls the latest snapshot, replays every newer event through `applyEvent`, and deep-diffs the result against live state. Soak passed `✅ 0 divergences` across all event types.

**D.4.D1 (dual-write shadow diff + event outbox).** Two additive pieces — localStorage still authoritative.

- **Shadow diff.** `trackEvent` is now a dispatcher: snapshots live state synchronously (via `validatorLiveRef`, updated render-time so the deferred compare sees post-mutation state), schedules a `setTimeout(0)` to replay the event through `applyEvent` against that snapshot, and diffs against the now-updated live state. Mismatches log a grouped `[shadow-diff] ❌` console error. Runs unconditionally for cloud-signed-in users on cloud-mirrored groups. Cost ≈ sub-ms per event. Every divergence = a real reducer bug.
- **Event outbox.** `window.api.postEvent(body)` wraps the `/api/events` POST; on transport failure or 5xx/408/429 the body is parked in `localStorage.shyft3_evt_outbox` (cap 500). Flushed in order on `visibilitychange→visible`, `online`, and once on load via `queueMicrotask`. 4xx errors are dropped. Idempotency caveat: server still mints event ids, so a retry that already committed creates a duplicate row — fine here because the outbox only fires on genuine transport failures (request never reached the server). D.4.D2 will tighten this with client-issued ids + INSERT-IGNORE.

**Soak gate before D.4.D2:** 3+ days of normal use with zero `[shadow-diff]` errors in console.

---

## Token efficiency rules

This is a hobby project on a personal token budget. Follow these rules to keep iterations cheap:

**Never read the wrong files**
- **`legacy/` is off-limits.** Never Read, never grep. v1/v2 are frozen archives kept only for git history.
- **Never Read `shyft-v3.html`** (the built artifact). It's regenerated by the build script and is just `head + JSX + tail` concatenated. To inspect content, Read `ShiftApp.v3.jsx` (or the head/tail templates). The *only* valid use of `shyft-v3.html` is the brace-count sanity pipe.
- **Never Read `Phases for Shyft and Rules for shift assignment.docx`, `Test logins.xlsx`, `svg code for logos.docx`, or any image** unless explicitly asked.

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
- **reconciliation**: assignments computed and frozen. Providers confirm/flag awarded shifts. Marketplace open. Auto-swap engine fires on flag.
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

`flagShift(dateKey, slotId, reason)` runs `computeAutoSwap` first. If a candidate is found (someone preferring this date, below max, not blocked, has seniority), the shift reassigns silently. If not, the entry is marked flagged AND auto-posted to the marketplace at zero incentive.

### Auto-swap engine

`computeAutoSwap(dateKey, slotId, originalUid)` returns the best swap candidate or `null`. Filters: prefers the date, below max, not blocked, has seniority, not already on this day. Tiebreak: highest `snapshotPtsForReconcile()` then lowest uid.

### Marketplace (take + two-sided trades)

```js
marketplace[i] = {
  id, dateKey, slotId, sellerId, incentivePts,
  postedAt, status: "open"|"taken"|"cancelled",
  takenBy?, takenAt?, autoPosted?, flagReason?,
  offers?: [{ id, offererId, offererDateKey, offererSlotId, incentivePts, status }]
}
```

Reducers: `_postListing`, `postForTake`, `takeListing`, `cancelListing`, `offerTrade`, `acceptTradeOffer`, `declineTradeOffer`. Listings appear in the **Trades** page (in nav for both providers and admin). Open count badged on nav.

---

## Coding conventions

- **Single-file React, no build tools.** Babel-standalone in the browser. JSX at runtime.
- **Tailwind via CDN** with extensions for `brand-*`, `ink-*`, `canvas`, `surface`, `shadow-card`. See head template.
- **Inter font.** Stat tiles use `tabular-nums` for alignment.
- **No external state libs.** Plain `useState`. Persistence via `window.storage` (a thin localStorage wrapper).
- **Compact code, dense comments.** The codebase favors slightly-dense JSX with explanatory comments above complex blocks rather than spreading things out. Match this style.
- **Source-tag awarded entries.** When awarding a shift, set `source` to one of: `pool` | `pool-solo` | `cascade` | `preferred-auto` | `available-auto` | `auto-swap` | `marketplace` | `admin`. The block report attributes by source.
- **Determinism for `applyEvent`.** Anything inside an `EVENT_HANDLERS` branch must be pure — no `Date.now()`, no `Math.random()`, no clock reads. If a handler needs entropy or a timestamp, the producer in `ShiftApp.v3.jsx` must capture it into the event payload (see D.4.B's `chainRepair`, `listing`, `awarded` enrichments).
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
- ✅ Calendar/ScheduleList read-only mode in Reconciliation+ (hide personal preferred/blocked overlays)
- ✅ Lock/Unlock confirm modals
- ✅ Block report (source-bucketed per-provider counts)
- ✅ Alerts module on admin dashboard
- ✅ **v3.1: Top Option model replacing per-slot pools**
- ✅ Phase A backend: magic-link auth, owner-issued invites (Cloudflare Worker + D1 + R2)
- ✅ Phase B event log (`POST /api/events` + 26 wired types)
- ✅ Phase C snapshot sync (debounced upload + Sync banner + Restore card)
- ✅ Phase D.1/D.2/D.2.5: password auth, one-shot migration, cloud-owner bridge + impersonation
- ✅ Phase D.3: cloud-backed signup + sign in, owner Accounts page
- ✅ Phase D.4.A: backend foundation (allow-list, `GET /api/events` tail, payload-size bump)
- ✅ Phase D.4.B: full `trackEvent` coverage + payload enrichments
- ✅ Phase D.4.C: `applyEvent` reducer + offline validator
- 🟡 Phase D.4.D1: dual-write shadow diff + event outbox (shipped, **in soak**)

### Pending (deferred by user)
- ⏳ **Lock-time point crediting** ("Step 2"). Today points credit at reconcile via `users.points` directly. Spec wants `users.points` (locked balance) split from `pendingPoints[blockId]` (this block's accruals), with pending → locked at the Lock transition.
- ⏳ Schedule snapshot at Lock (frozen "My final schedule" view per user, persisted with the block).
- ⏳ Phase D.4.D2: cloud-authoritative cutover. Plan in `~/.claude/plans/crispy-twirling-nest.md`.
- ⏳ Phase D.4.E: polish (UUID event ids, retired `Date.now()` ids, etc.).
- ⏳ R2 monthly event-log archival (deferred until corpus grows).
- ⏳ Mandatory `If-Match` on snapshot uploads (concurrency control beyond last-write-wins).

---

## Verification quick reference

Build + brace check:

```bash
# Run from the project root (the folder that contains ShiftApp.v3.jsx and templates/).
N=$(grep -n "^export default function ShiftApp" ShiftApp.v3.jsx | cut -d: -f1)
{ cat templates/shyft_head.v3.html; tail -n +"$N" ShiftApp.v3.jsx | sed 's/^export default function ShiftApp/function ShiftApp/'; cat templates/shyft_tail.v3.html; } > shyft-v3.html
o=$(grep -o '{' shyft-v3.html | wc -l) && c=$(grep -o '}' shyft-v3.html | wc -l) && echo "braces $o/$c"
```

**⚠ Opening `shyft-v3.html` from `file://` no longer works post-D.3.** All sign-in paths go through the Worker (`/api/auth/password`, `/api/auth/signup`, `/api/me`), so the auth screen loads but has no way to authenticate without the backend running. Use one of:

- **`npx wrangler dev --remote`** — runs the Worker at `http://localhost:8787` but proxies D1, R2, and secrets to the deployed instances. Real cloud auth, real event log, no production deploy needed. Lowest friction for local smoke testing.
- **`npx wrangler deploy`** — full production push to `app.shift-scheduling.com`. Use when you're ready to soak against real traffic, or when testing something that only manifests in production (e.g. cookie-domain edge cases, custom-domain CSRF).

Smoke test (against either of the above):
1. Sign in as admin → Setup → create a block in Availability phase
2. Sign in as provider → Schedule → tap a day → 🎯 Top Option → bid + slot pref
3. Repeat for a few providers, some contested
4. Admin → Close & assign → verify report shows pool/cascade/auto rows
5. Provider → Mine → confirm one shift, flag another (try both auto-swap and no-candidate paths)
6. Trades page → take a listed shift as another provider
7. Admin → Lock block

D.4 verification (cloud-signed-in owner only):
- DevTools console should stay quiet — any `[shadow-diff] ❌` line is a real reducer bug. Screenshot + diagnose before shipping the next change.
- After a batch of events, run `await window.__shiftValidator.run()` in DevTools; expect `✅ 0 divergences`.
- Outbox check: DevTools → Network → Offline → fire one event → Online → confirm `localStorage.getItem("shyft3_evt_outbox") === "[]"` after the flush.

---

## Working with the user (David)

- Prefers conversational design discussions before implementation. When proposing a change with multiple valid approaches, surface 2–3 alternatives.
- Builds incrementally. Each step should produce a working artifact.
- Wants the UI to remain simple for end users. Prefers consolidating duplicate concepts over adding more controls.
- Single-file React + Tailwind + babel-standalone is non-negotiable. Don't introduce a build tool.
- TodoWrite is welcome for multi-step features. Skip it for trivial changes.
- Plan mode is welcome for significant architectural changes — user often initiates with "go in to plan mode."
