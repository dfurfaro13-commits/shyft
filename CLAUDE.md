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
| `~/.claude/plans/*.md` | Planning artifacts. Look for the most recent one for context on the latest change. |

---

## Backend (Phase A → D.4.D2, all shipped)

The Cloudflare Worker fronts a D1 database + R2 bucket. As of D.4.D2, cloud is the source of truth: `loadGroup` rehydrates from snapshot + event-tail replay, mutations go through `applyAndTrack` → reducer → POST event, a 15s poll syncs cross-device. localStorage still holds the per-group cache (so the UI reads it directly) but it's downstream of the reducer, not the source.

- **Deploy:** `npx wrangler deploy` (after `wrangler login`, `d1 create shift-db`, paste id into `wrangler.jsonc`, run each `migrations/000*.sql` file via `d1 execute shift-db --remote --file=…`, `r2 bucket create shift-events`, and `wrangler secret put RESEND_API_KEY`, `SESSION_PEPPER`, `OWNER_BOOTSTRAP_CODE`).
- **Local dev:** `npx wrangler dev`. Create `.dev.vars` (gitignored) with `RESEND_API_KEY=...` and `DEV_EMAIL=console` to log magic links instead of sending.
- **Email sender:** custom domain is live (`shift-scheduling.com` via Resend, sender `noreply@shift-scheduling.com`). `EMAIL_FROM` is configured; magic links deliver to any address.
- **CSRF:** every state-changing API call must send `X-Requested-With: shift`. The `window.api.fetchJSON` shim in `templates/shyft_head.v3.html` adds it automatically.
- **Sessions:** opaque `shift_sid` cookie. Server stores `SHA-256(SESSION_PEPPER + raw)`; raw value never persisted.
- **Deploy hygiene.** The Worker's `assets.directory` is `./` (worktree root), so anything not excluded by `.assetsignore` ships as a public asset. Current `.assetsignore` excludes `*.sql`, `*.sqlite*`, `.git`, `.git/`, `.dev.vars`, `src/`, `migrations/`, etc. Before any deploy, sanity-check what `wrangler deploy` reports as new uploads.

### Phase B — append-only event log

Every meaningful state mutation fires `POST /api/events` to D1. The original call surface was a component-local `trackEvent(type, payload, opts?)` helper; D.4.D2 Phase 3 superseded that with `applyAndTrack`, and `trackEvent` itself was removed for being dead code. The Worker rejects unknown types — to add a new event type, append it to `ALLOWED_TYPES` in `src/api/events.js` first. 27 wired types currently (26 from D.4.A/B + `shift.take-open` for provider self-take from Trades). R2 archival of the event log is deferred — D1 is queryable directly and we'll dump monthly archives only when the corpus gets large enough to need it.

### Phase C — snapshot sync

After every per-group `persist()`, a debounced uploader fires `POST /api/snapshots` with the entire per-group state plus the local-only group metadata (`groupCode`, `adminCode`, `name`, `createdAt`). D1 stores the latest (one row per group, last-write-wins); R2 stores history at `snapshots/<groupId>/<server_ts>-<client_ts>.json`. D.4.D2 Phase 4 demoted the uploader: **2s → 30s debounce + dirty gate** (only uploads when `persist` has run since the last successful upload).

**The manual Sync banner (`checkCloudSyncOffer` / `acceptCloudSync` / amber JSX) was removed in D.4.D2 Phase 5** — the 15s periodic poll handles cross-device sync continuously now. `applySnapshot` survives because the first-device-claim Restore card on the auth screen and the owner-auto-restore useEffect both still need it: any cloud membership not matched to a local `groups[]` entry renders a "Restore" card; clicking pulls the latest snapshot and creates the local group from `payload.meta`.

`buildSnapshotPayload` reads from a `snapshotStateRef` updated render-time (not via useEffect). This fixes a stale-closure bug where the 2s debounced upload was uploading pre-mutation state — caught by D.4.C's validator.

**Concurrency control.** `POST /api/snapshots` accepts `If-Match: <serverTs>` and returns 409 with the current serverTs when stale. The frontend doesn't yet send `If-Match` — backwards-compatible last-write-wins is preserved. Making it mandatory remains deferred.

### Phase D — backend-as-truth (D.1 + D.2 + D.2.5 + D.3 + D.4.A + D.4.B + D.4.C + D.4.D1 + D.4.D2 shipped)

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

**D.4.C (applyEvent reducer + offline validator).** Pure-function reducer (`applyEvent(state, evt)` in `templates/shyft_head.v3.html`; the JSX preamble holds signature-only stubs for IDE awareness) maps each of the 26 event types onto a state transition. Deterministic: no `Date.now()`, no `Math.random()`, no clock reads — all stamping data either lives in payload (D.4.B's enrichments) or is derived from existing state. Idempotency via a FIFO `appliedEventIds` ring (cap 200). Unknown event types are forward-compat no-ops. Validator: `window.__shiftValidator.run()` (cloud-owner only) pulls the latest snapshot, replays every newer event through `applyEvent`, and deep-diffs the result against live state. Soak passed `✅ 0 divergences` across all event types.

**D.4.D1 (dual-write shadow diff + event outbox).** Two additive pieces — localStorage still authoritative.

- **Shadow diff.** `trackEvent` is now a dispatcher: snapshots live state synchronously (via `validatorLiveRef`, updated render-time so the deferred compare sees post-mutation state), schedules a `setTimeout(0)` to replay the event through `applyEvent` against that snapshot, and diffs against the now-updated live state. Mismatches log a grouped `[shadow-diff] ❌` console error. Runs unconditionally for cloud-signed-in users on cloud-mirrored groups. Cost ≈ sub-ms per event. Every divergence = a real reducer bug.
- **Event outbox.** `window.api.postEvent(body)` wraps the `/api/events` POST; on transport failure or 5xx/408/429 the body is parked in `localStorage.shyft3_evt_outbox` (cap 500). Flushed in order on `visibilitychange→visible`, `online`, and once on load via `queueMicrotask`. 4xx errors are dropped. Idempotency caveat: server still mints event ids, so a retry that already committed creates a duplicate row — fine here because the outbox only fires on genuine transport failures (request never reached the server). Client UUIDs + `INSERT OR IGNORE` are deferred to D.4.E.

**D.4.D2 (cloud-authoritative cutover).** Six sub-phases, all shipped. localStorage is now downstream of the reducer.

- **Phase 1 — `loadGroup` cloud-first.** `loadGroupFromCloud(gid, cloudGid)` pulls `/api/snapshots/:gid/latest`, replays events since `snap.serverTs` through `applyEvent`, stamps a per-group `shyft3_g<gid>_lastSeenServerTs` cursor, and writes through to localStorage via `writeGroupStateToStorage` (8 per-group keys). Conservative reverse-sync guard: if local has data AND the cloud snapshot has no payload, push local up first to protect the D.4.B → D.4.D2 danger window. `loadGroup` falls back to local-only on any cloud failure.

- **Phase 2 — periodic poll.** New `useEffect` gated on `(groupId, cloudUser, currentGroup.cloudGroupId, me.id)`. While the document is visible, polls `GET /api/events?gid=&since=<lastSeenServerTs>` every 15s. Each batch is filtered (skip events stamped with this tab's `SHYFT_CLIENT_ID`), replayed through `applyEvent` via `validatorLiveRef`, and changed slices are dispatched via `setX + persist`. Visibility-aware (start on visible, clear on hidden, immediate poll on each transition); inflight guard prevents overlap.

- **Phase 2.1 — per-tab `SHYFT_CLIENT_ID`.** Random UUID held in `sessionStorage` (survives reload, unique per tab); module-scope constant in head template, mirrored in JSX preamble. Stamped into every event payload by `buildEventBody` (via `applyAndTrack`). Cross-device poll filters on `evt.payload.clientId === SHYFT_CLIENT_ID` (skip own-tab events). Fixes the two-windows-of-the-same-user sync gap that the old `localUid == me.id` filter created. Pre-2.1 events without `clientId` fall back to the legacy `localUid` filter.

- **Phase 3 — mutation flow refactor.** All 26 imperative `trackEvent` callsites are gone. Each mutation now flows through `applyAndTrack(type, payload, opts)`:
  1. `buildEventBody(type, payload, opts)` builds the wire body (extracted from `trackEvent` so `applyAndTrack` and `trackEvent` share one canonical body + one `clientTs` — the reducer reads `e.clientTs` for `postedAt`/`takenAt` fields and any drift between the two would surface as shadow-diff).
  2. Stamps a local `id` (`local_${Date.now()}_${rand}`) onto the event so `applyEvent`'s `if (!evt.id) return state` guard doesn't bail. The local id is NOT in the body POSTed to the server (server still mints).
  3. Runs `applyEvent(cleanBefore, evt)` against `validatorLiveRef.current`.
  4. Object-identity diffs each slice — only `setX + persist`s the slices that actually changed (reducer returns the same reference for untouched slices).
  5. POSTs the same body the reducer consumed. Shadow-diff is intentionally bypassed because predicted == actual by construction now.
  Producer side stays responsible for eligibility checks + capturing non-deterministic inputs into payload (e.g. `chainRepair`, listing ids, `pointsTransferred`). Two helper deletions fell out: `_postListing` (callers inline the "find existing or mint id" branch) and `updateCurrentBlock` (every block transition fires its own event whose reducer patches `config.blocks` via `patchBlockInConfig`).

- **Phase 4 — snapshot uploader demotion.** Debounce `2s → 30s`; `snapshotDirty` ref gates `uploadSnapshot` (set true by `persist()` on any write, cleared on successful POST). Snapshot is now a compaction optimization + rehydration baseline, not the primary persistence path. Event log + poll are authoritative for realtime sync.

- **Phase 5 — manual Sync banner removed.** Polling supersedes it. Deleted `cloudSyncOffer` state, `checkCloudSyncOffer`, the dependent `useEffect`, `acceptCloudSync`, and the amber banner JSX.

**Two latent bugs surfaced + fixed during Phase 3 soak:**
- Wire-format string vs local numeric uid mismatch in the marketplace flow (`offer.offererId` stored as string by `trade.offer-post` reducer, compared with strict-equality against numeric `me.id` in `acceptTradeOffer`). Fix: `uidVal(fromUid)` in the reducer + `String(a) === String(b)` defensive comparisons across the affected handlers (commits `73919da` for the swap-admin equivalent, `a09bf4f` for offer/accept).
- `applyEvent`'s `if (!evt.id) return state` guard caused `applyAndTrack` to no-op silently when first written (server mints id on POST; applyAndTrack had no local id). Symptom: A's tab didn't update on its own actions even though B saw them via poll. Fix: stamp `local_${ts}_${rand}` on the evt (commit `c645e29`).

**`block.reconcile` payload contract had three latent shape bugs** that the pre-Phase-3 imperative `applyReconcile` masked (post-mutation awaits made `validatorLiveRef` stale at shadow-diff time, turning the diff vacuous for shifts/openIncentives and only-real for the users cascade). Surfaced + fixed in commit `8e2cd63`: payload `awards` shape was `{winner, slot: target, ...}` but reducer reads `{uid, slotId, ...}` (silently skipped all entries); payload only carried reconcile awards, not auto-assign cells (replaying devices missed auto-assigns); `applyAwardsToShifts` hardcoded `auto: false`. All three fixed: rebuild a flat awards array from diffing `finalShifts` vs pre-reconcile `shifts`, in reducer-expected shape, with `auto` carried through.

**Accounts delete cascade** (commit `af62dbf` + D.4.E follow-up): owner-level `DELETE /api/owner/users/:uid` now triggers cleanup at three layers:
- Client, currently-loaded group: `applyAndTrack("user.delete", { uid, cascadeShifts })` — reducer handles the four-slice cascade + cross-device event propagation via the event log.
- Client, non-loaded affected groups: hand-edit localStorage (so the next time the deleter opens those groups they don't see the user).
- Server (D.4.E): for each affected (group_id, local_uid) pair, `patchSnapshotRemoveUser` in `src/api/owner.js` rewrites the D1 snapshot — filter user out of `payload.users`, cascade-clean `shifts` / `unavail` / `prefs` / `topOptions` — and writes a fresh R2 history entry stamped `patchedBy: "deleteOwnerUser"`. Ensures any other device opening the group later via `loadGroupFromCloud` pulls correct state, not stale.

Reducer's `user.delete` extended in the same D.4.E commit to also cascade `topOptions` (was missing — would have left zombie bid entries on cross-device replay).

### Self-service profile + forgot-password (post-D.4.E)

Two small surfaces layered on top of the Phase D foundation; no protocol changes, just new endpoints.

**Profile** ([src/api/profile.js](src/api/profile.js)) — three endpoints, all require a live session, all CSRF-checked:
- `PATCH /api/me/profile { displayName }` — updates `users.display_name`. Frontend additionally propagates by firing a `user.update` event into the event log of EVERY group the caller is a member of, so per-group `users[gid][i].name` (what the schedule UI actually renders) stays in sync. For the currently-loaded group it routes through `applyAndTrack`; for other groups it hand-edits each group's localStorage `users[]` + posts a standalone `user.update` event so the next loadGroup/poll on those groups sees the new name.
- `POST /api/me/password { currentPassword, newPassword }` — re-auths via `verifyPassword` then writes a fresh hash. The current-password gate is what stops a hijacked open session from locking the real user out.
- `POST /api/me/change-email-request { newEmail }` — uniqueness check, mints a token in `email_change_tokens` (migration 0006), emails a confirmation link to the NEW address via `sendEmailChangeLink` (a sibling of `sendMagicLink` sharing the `sendLink` core in [src/lib/email.js](src/lib/email.js)). The change is applied by `GET /api/auth/verify-email-change?token=…` in [src/api/auth.js](src/api/auth.js), which validates + re-checks uniqueness at apply-time (race against concurrent claims) + flips `users.email`. Existing sessions stay valid; the new email shows on the next `/api/me` poll.

Frontend surface: `ProfileModal` opens when the user clicks their name. Sidebar chip (desktop), avatar (mobile topbar), and an explicit "Profile" button next to "Sign out" in the SuperDashboard topbar all open it. Disabled during impersonation (would edit the owner's profile under the impersonated name).

**Forgot password** ([src/api/reset.js](src/api/reset.js)) — three endpoints:
- `POST /api/auth/forgot-password { emailOrUsername }` — lookup by email OR username, rate-limited 5/hr per user via row count in `password_reset_tokens` (migration 0007), always returns 204 so callers can't enumerate accounts.
- `GET /api/auth/reset-password?token=…` — server-rendered HTML form (matches the verify-page style), two password fields + confirm-match in inline JS. Tokens are 32-byte random, single-use, 15-min TTL.
- `POST /api/auth/reset-password { token, newPassword }` — validates token + applies new hash, revokes other live sessions for the user (forgotten password could imply compromise), mints a fresh session via Set-Cookie. CSRF still required — the form's inline JS adds `X-Requested-With`, so an embed on a third-party site can't drive this.

Frontend: "Forgot password?" link below the magic-link button on the Sign in form. Click → inline form with single "Email or username" input → confirmation message uses deliberately-vague phrasing ("If &lt;input&gt; matches an account…") to avoid leaking account existence.

### Account management ergonomics (today)

- Owner can self-edit through the **Profile** button (the Accounts modal still excludes the caller, per the existing server-side filter).
- `AccountsEditModal` now requires confirm-twice for both email and password. Each "Confirm" input is disabled until its primary field has content. `submitAccountsEdit` rejects with a specific error before sending if either pair doesn't match. Rationale: an owner typo on a password reset would lock the target user out with no recovery path other than another owner edit.

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

- **📊 Block report** (existing) — totals + per-provider breakdown for the active block. Per-provider table columns: Provider | Total | M/I/Mx | Top | Pref | Avail | Adm | Wknd | Spend | Proj. Source-bucket counts carry a `(P%)` suffix relative to the row's total (omitted for zeros). `Spend` is current `users.points`; `Proj` is `points + getPtsEarned − pendingPenalty` (`pendingPenalty` only non-zero in AVAIL). After lock, Proj == Spend by construction.
- **📈 Provider report** (new) — same layout aggregated over N blocks via a top-of-modal "Last N / All blocks" dropdown. Sums source buckets across selected blocks; M/I/Mx sums per-block via each block's `targetsAtClose` snapshot (falls back to current values for pre-feature blocks with an amber footnote flag). Spend/Proj remain point-in-time. Selecting "Last 1 block" produces output equivalent to Block Report on the current block.

### Remaining Issues alert

A third alert type inside the admin dashboard's existing **Alerts** card, surfacing during **Reconciliation + Locked** phases when there are unfilled slots. `diagnoseOpenShifts()` walks every open `(dateKey, slotId)` and classifies each provider's state on that date into one of: `blocked` / `topOptOtherSlot` (Top-Optioned the day but won the other slot) / `preferredAtMax` / `availableAtMax` / `alreadyOnDay` / `eligible`. The per-slot row shows reasons (e.g. "3 preferred this day but are at max (Alice, Bob, Carol)") plus suggestions (manual assign one of N eligible / raise max / unblock outreach / set an incentive), with an "Open day →" button that opens the existing DaySheet for that date. Hidden in AVAIL (open slots are normal during signup).

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
- TodoWrite is welcome for multi-step features. Skip it for trivial changes.
- Plan mode is welcome for significant architectural changes — user often initiates with "go in to plan mode."
