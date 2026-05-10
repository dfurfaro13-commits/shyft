# SHIFT — Claude Code project notes

The product is **SHIFT Scheduling** (call it **SHIFT** for short) — a scheduling application **for medical professionals**. Providers sign up for / bid on shifts, an admin reconciles, a marketplace handles last-minute trades. Built around a phased lifecycle (availability → reconciliation → locked) with a points-based priority system.

This file is the catch-up brief for Claude Code instances joining the project mid-stream. **Read it first** before exploring code — the architecture has a few non-obvious gotchas that will burn time if you discover them by accident.

> **Naming note for Claude:** the codebase predates the rebrand and still uses **`shyft`** in technical identifiers — file names (`ShiftApp.v3.jsx`, `shyft-v3.html`, `templates/shyft_head.v3.html`), the localStorage namespace (`shyft3_*`), and the migration markers (`shyft3_migrate_from_v2`, `shyft3_g{gid}_migrate_top_options`). **Leave these alone.** Renaming the storage namespace would invalidate every existing user's data. Only update brand mentions in user-facing UI strings, comments, and docs. (The old `SUPER_BOOTSTRAP = "Shyft-Kai-Dave"` constant moved to a Worker secret, `OWNER_BOOTSTRAP_CODE`, in D.3 — same value, different home.)

---

## Product principles

The interface must be **clean, professional, simple, and intuitive.** This is the audience's standing requirement — medical professionals don't have time to learn a complex tool, and the UI carries the credibility of the product. When in doubt, simplify. When asked between "more powerful" and "easier to understand," pick easier. Recent design moves (e.g. the v3.1 collapse from per-slot pools + per-day preference into a single 4-state Top Option model) are worked examples of this principle.

## Project scope & constraints

- **Hobby project.** David is building this on his own time. **Keep recurring costs near zero.** No paid SaaS dependencies, no per-seat licenses, no managed services that charge by request volume. Default to self-hostable / free-tier / open-source choices. If something must cost money, flag it with a cost estimate before implementing.
- **No backend yet.** All state is in browser localStorage. This is intentional and fine for the current single-user-per-browser hobby phase.
- **Future direction (not yet started):**
  - **Backend that auto-logs all scheduling data** so the model can learn from it (which providers bid what, how reconciliations played out, who flagged shifts, etc.). Persistent server-side store, append-only log shape preferred. Treat this as a near-term ambition — design new features so they're easy to mirror server-side later.
  - **Hosted as a website** so anyone can visit it. Static-host-friendly (the current single-file build is already there). Likely target: GitHub Pages / Cloudflare Pages / Netlify free tier.
- **Don't pre-build the backend.** The frontend is still the active surface. When designing new features, just keep the data model clean and append-friendly so the eventual backend port is straightforward.

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
- Date helpers, color tables, etc.

Component-local helpers (anything inside `function ShiftApp(...)`) only need updating in the JSX — they're inside the slice that gets included.

---

## File map

| Path | Role |
|------|------|
| `ShiftApp.v3.jsx` | Source of truth for all v3 code. Edit this. |
| `templates/shyft_head.v3.html` | Runtime preamble (DOCTYPE, Tailwind config, migration, module-scope helpers). Mirror constants here. |
| `templates/shyft_tail.v3.html` | Runtime postamble. Just `<ReactDOM>.render()`. Don't touch. |
| `shyft-v3.html` | Built artifact. **Never edit by hand** — gets overwritten. Cloudflare Pages serves this. |
| `index.html` | Tiny redirect to `shyft-v3.html` so the root URL of the deployed site loads the app. |
| `wrangler.jsonc` | Cloudflare Worker config. Now also binds the API Worker (`_worker.js`), D1 (`DB`), and R2 (`R2`). |
| `_worker.js` | Worker entrypoint. Routes `/api/*` to the API; everything else falls through to static assets via `env.ASSETS.fetch`. |
| `src/api/` | API handlers (`auth.js`, `groups.js`) + `router.js`. Phase A only — no event/snapshot endpoints yet. |
| `src/lib/` | Backend helpers (`db`, `session`, `cookies`, `email`, `csrf`, `ids`, `ratelimit`, `http`). |
| `migrations/0001_init.sql` | D1 schema for Phase A: `users`, `groups`, `memberships`, `invites`, `login_tokens`, `sessions`. |
| `migrations/0002_events.sql` | Phase B append-only event log (`events` table). |
| `migrations/0003_snapshots.sql` | Phase C per-group state snapshot (`snapshots` table). Latest only — full history lives in R2. |
| `migrations/0004_users_passwords.sql` | Phase D.1: adds `users.password_hash`, `users.kind`, and `password_attempts` rate-limit table. |
| `migrations/0005_username_owner.sql` | Phase D.3: adds `users.username` (partial unique), `users.can_create_groups`, `groups.group_code`, `groups.admin_code`, plus `signup_attempts`. Backfills owner permission + group/admin codes from snapshots. |
| `Phases for Shyft and Rules for shift assignment.docx` | The spec. Source of truth for behavior. Re-read when in doubt. |
| `legacy/` | Archived v1/v2 source + built HTML, plus v1-era assignment-algorithm simulators (`simulate.js`, `simulate.py`). **Do not read or grep into.** |
| `~/.claude/plans/*.md` | Planning artifacts. Look for the most recent one for context on the latest change. |

---

## Backend (Phase A)

Phase A added a Cloudflare Worker + D1 backend for **magic-link auth and owner-issued invite links** — nothing more. localStorage is still source of truth for all scheduling data; the cloud session is purely additive.

- **Deploy:** `npx wrangler deploy` (after `wrangler login`, `d1 create shift-db`, paste id into `wrangler.jsonc`, run each `migrations/000*.sql` file via `d1 execute shift-db --remote --file=…`, `r2 bucket create shift-events`, and `wrangler secret put RESEND_API_KEY`, `SESSION_PEPPER`, `OWNER_BOOTSTRAP_CODE`).
- **Local dev:** `npx wrangler dev`. Create `.dev.vars` (gitignored) with `RESEND_API_KEY=...` and `DEV_EMAIL=console` to log magic links instead of sending.
- **Email sender:** custom domain is live (`app.shift-scheduling.com` via Resend). `EMAIL_FROM` is configured; magic links deliver to any address.
- **CSRF:** every state-changing API call must send `X-Requested-With: shift`. The `window.api.fetchJSON` shim in `templates/shyft_head.v3.html` adds it automatically.
- **Sessions:** opaque `shift_sid` cookie. Server stores `SHA-256(SESSION_PEPPER + raw)`; raw value never persisted.
- **Auth model post-D.3:** cloud is the source of truth. Auth screen has 2 tabs (Sign in / Sign up); both call cloud APIs. The local-session path in `me` only fires during owner impersonation; otherwise `me` is derived from `cloudUser`. The `OWNER_BOOTSTRAP_CODE` Worker secret (currently `Shyft-Kai-Dave`) gates group creation via the optional Owner code field on Sign up.

Phase C (snapshot sync) is not implemented.

### Phase B — append-only event log

Every meaningful state mutation also fires a `POST /api/events` to D1 — the primary ML training corpus. localStorage is still source of truth; the event log is parallel, fire-and-forget, and silently no-ops when the user isn't cloud-signed-in or the active group hasn't been mirrored. The component-local helper `trackEvent(type, payload, opts?)` (in `ShiftApp.v3.jsx`, near the cloud helpers) is the only call surface — search for `trackEvent(` to find every wired call site.

Currently logged event types: `topOption.set`, `topOption.clear`, `topOption.link`, `topOption.unlink`, `preference.toggle`, `unavail.toggle`, `block.reconcile`, `block.lock`, `block.unlock`, `shift.confirm`, `shift.flag`, `marketplace.post`, `marketplace.take`, `marketplace.cancel`. The Worker rejects unknown types — to add a new event type, append to `ALLOWED_TYPES` in `src/api/events.js` first. (D.4.A added a batch of types reserved for D.4.B wiring — see the D.4.A subsection below.)

R2 archival of the event log (originally part of the Phase B plan) is deferred — D1 is queryable directly and we'll dump monthly archives to R2 only when the corpus gets large enough to need it.

### Phase C — snapshot sync

After every per-group `persist()`, a debounced uploader (~2s) fires `POST /api/snapshots` with the entire per-group state plus the local-only group metadata (`groupCode`, `adminCode`, `name`, `createdAt`). D1 stores the latest (one row per group, last-write-wins). R2 stores history (one immutable object per write at `snapshots/<groupId>/<server_ts>-<client_ts>.json`).

Two consumer flows on the frontend:

- **Sync banner.** When a cloud-signed-in user opens a cloud-mirrored group, `checkCloudSyncOffer` compares the server's `client_ts` to this device's `shyft3_g<gid>_lastModified`. If cloud is meaningfully newer, an amber banner appears at the top of the in-group shell offering "Sync now" — which calls `applySnapshot` to overwrite the 8 per-group keys and reload the group.
- **First-device-claim.** On the auth screen, `cloudUser.memberships` is filtered against local `groups[]` (matched by `cloudGroupId`). Any unclaimed cloud group renders a "Restore" card; clicking it pulls the latest snapshot, creates a new local `groups[]` entry from `payload.meta`, and writes the 8 per-group keys. The user then signs in locally with credentials that came back inside the snapshot's `users` array.

The uploader silently no-ops when the user isn't cloud-signed-in or the active group has no `cloudGroupId`. localStorage remains source of truth — Phase C is mirroring, not migration.

### Phase D — backend-as-truth (D.1 + D.2 + D.2.5 + D.3 + D.4.A shipped)

**D.1 (password auth + cloud user creation).** Cloud users now carry an optional PBKDF2 `password_hash` (SHA-256 with 310k iters, 16-byte salt; format `pbkdf2$310000$<salt>$<hash>`) and a `kind ∈ ('real','test')` designator. New endpoint `POST /api/auth/password` issues a session for `email + password`; rate-limited at 10/hr per `(email, ip)` via the new `password_attempts` table. Endpoint `POST /api/users` lets an owner/admin create a cloud user + membership — `kind='test'` mints a synthetic `<localId>@<cloudGroupId>.test.invalid` email and a temp password returned in the response; `kind='real'` validates the supplied email and pre-issues a magic-link via Resend.

The admin "+ Add user" modal in PeoplePage now creates BOTH a local user (existing flow) AND, when the active group is cloud-mirrored AND admin is cloud-signed-in, a cloud user via `POST /api/users`. The modal gains a "Test user (synthetic email, no magic-link sent)" checkbox visible only when cloud creation is possible. `NewUserInfoModal` shows local credentials and, if the cloud user was also created, the cloud credentials in a separate panel. The auth-screen Cloud tab gained a password field — leaving it empty falls through to the existing magic-link flow.

**D.2 (one-shot migration).** `POST /api/groups/:gid/migrate` creates a cloud group, marks the caller `owner`, creates one `kind='test'` user per local user with a synthetic email + freshly-generated PBKDF2 password (returned in response so admin can hand them out), and uploads the supplied snapshot directly to D1 + R2. The SuperDashboard renders a **"Migrate to cloud"** button on every local-only group when the admin is cloud-signed-in. The confirm-modal lists the users about to be migrated; on success, the result-modal lists each user with their email + temp password (only shown once).

**D.2.5 (cloud-owner bridge + owner impersonation).** Two pre-D.3 changes that make the local-auth tabs deletable without locking the owner out or losing the test-user-switching workflow:

- **Cloud-owner bridge.** The `me` useMemo in `ShiftApp.v3.jsx` (~line 343) now derives `me.role === "super"` from `cloudUser.memberships.some(m => m.role === "owner")` when no local session is present. The auth-screen guard (~line 2154) was changed from `if(!session||!me)` to `if(!me)` so a cloud-only owner reaches SuperDashboard. Precedence is: impersonation > local session > cloud-owner bridge — a local sign-in always wins so signing in as a test user works mid-cloud-session.
- **Owner impersonation.** Each group card in SuperDashboard has a **"👁 View as"** button → `ImpersonatePickerModal` lists admins+providers for that group (read directly from localStorage via `readGroupKey`, no group-load required) → `startImpersonate(gid, localUid)` awaits `loadGroup` then sets the `impersonate` state. State shape: `{groupId, localUid}`, persisted in `sessionStorage` under `shyft3_impersonate` so it survives reloads in the same tab. While impersonating, an amber sticky banner at the top of the main app shows "👤 Impersonating <name> · Stop" — Stop calls `stopImpersonate` which clears state, clears group context, and returns to SuperDashboard via the cloud bridge. Component-local helpers, no head-template mirror needed. **Caveat:** events fired during impersonation hit `/api/events` as if from the impersonated user — fine for test groups, revisit if real users get onboarded pre-D.3.

**D.3 (cloud-backed auth).** Local Sign in / Sign up are gone; their replacements are cloud-backed and live on the same two-tab auth screen. Migration `0005_username_owner.sql` adds `users.username` (nullable, unique-when-not-null partial index), `users.can_create_groups`, `groups.group_code`, `groups.admin_code`, plus a `signup_attempts` rate-limit table. The migration grandfathers existing owners by setting `can_create_groups = 1` for everyone with an `owner` membership, and backfills `groups.group_code` / `admin_code` from the latest snapshot's `payload.meta`.

- **`POST /api/auth/signup`** ([src/api/signup.js](src/api/signup.js)): self-serve. Body `{ displayName, email, username, password, groupCode?, adminCode?, ownerCode? }`. Owner code is matched against the `OWNER_BOOTSTRAP_CODE` Worker secret; valid → `can_create_groups = 1` AND group code becomes optional (cold-start owner). With a group code, the user joins as `provider`; supplying a matching admin code elevates to `admin`. PBKDF2 password hash (same params as D.1). Rate-limited 10/hr per IP via `signup_attempts`.
- **`POST /api/auth/password`** updated to look up by `email OR username` (single `emailOrUsername` field on the wire). Backwards-compat alias `email` is still accepted by the body parser. Response now includes `username` and `canCreateGroups`.
- **`POST /api/groups`** and **`POST /api/groups/:gid/migrate`**: gated on `can_create_groups`; 403 otherwise. Both also persist `group_code` and `admin_code` on the row (migrate pulls them from `payload.meta`).
- **`getSessionUser` / `GET /api/me`**: now returns `username` and `canCreateGroups` on the user object.
- **`OWNER_BOOTSTRAP_CODE` secret**: currently `Shyft-Kai-Dave`. Set via `wrangler secret put OWNER_BOOTSTRAP_CODE` and in `.dev.vars` for local dev.

Frontend ([ShiftApp.v3.jsx](ShiftApp.v3.jsx)):

- Auth screen has 2 tabs (Sign in / Sign up); the old Owner and Cloud tabs are gone.
- Sign in: single "Email or username" field + password + "Or email me a sign-in link instead" link (magic-link fallback only fires when the input contains `@`).
- Sign up: name + email + username + password + group code + admin code + owner code. Group code is required unless the owner code is present (cold-start owner case).
- `handleAuth` is now a thin dispatcher to `signInCloud` / `signUpCloud`. The `signUpCloud` response has the `/api/me` shape and is dropped straight into `cloudUser`.
- **`enterGroupAsCloudMember`** is the post-auth navigation helper for non-owner roles. After a successful sign in or sign up, if the user has a non-owner membership it: pulls the latest cloud snapshot for the group (or creates an empty mirror if none), inserts a local `groups[]` entry + a local `users[gid][i]` entry tagged with `cloudUserId`, and sets `session = {groupId, userId}` so the `me` useMemo resolves. Without this helper, providers/admins land on the auth screen with a "Restore" card and no way in. Owners are a no-op — the cloud bridge takes them to SuperDashboard.
- The `me` useMemo's `session?.superId` branch is gone. The cloud bridge now triggers on `cloudUser.memberships.some(m => m.role === "owner") || cloudUser.user.canCreateGroups` — the latter handles a brand-new owner who hasn't created their first group yet.
- `SUPER_BOOTSTRAP` (in both the JSX preamble and `templates/shyft_head.v3.html`), the `supers` state, the local-only `signInWithPassword` helper, the standalone `signOutCloud` helper, and the `cloudEmail` / `cloudPassword` state are all deleted. The unified `signOut` revokes the cloud session AND clears local + impersonation state in one call. The pre-D.3 `shyft3_supers` localStorage key is pruned on first load via a one-shot block in `templates/shyft_head.v3.html` (marker `shyft3_migrate_prune_supers`).
- The "X owner accounts" footer and the redundant blue "Sign out (cloud)" strip in SuperDashboard are removed; one Sign out button per UI surface.

**Concurrency control.** `POST /api/snapshots` accepts `If-Match: <serverTs>` and returns 409 with the current serverTs when stale. The frontend doesn't yet send `If-Match` — backwards-compatible last-write-wins is preserved. Making it mandatory remains deferred.

**Accounts management.** Owner-only surface in SuperDashboard (top-right "Accounts" button). Backend: [src/api/owner.js](src/api/owner.js) exposes `GET /api/owner/users` (list users in caller's owned groups, self excluded, memberships rolled up), `PATCH /api/owner/users/:uid` (change email and/or password — backend rejects self-edit, email collisions, short passwords), and `DELETE /api/owner/users/:uid` (drops memberships in caller's owned groups; if no memberships remain anywhere, fully tombstones — anonymizes email/display_name, NULLs username + password_hash, deletes sessions + login_tokens + password_attempts; refuses to delete a user who owns any group). Frontend: `AccountsModal` lists users with kind/magic-link badges and (group, role) chips; `AccountsEditModal` and `AccountsDeleteModal` are the action surfaces. Tombstoned users naturally drop out of the list (no memberships → JOIN excludes). Cherry-picked from the now-stale `wip/parallel-d3-with-accounts` branch.

**Deploy hygiene.** The Worker's `assets.directory` is `./` (worktree root), so any file in the root that isn't excluded by `.assetsignore` ships as a public asset. During the D.3 deploy a D1 backup (`backup-pre-d3-*.sql`) and the `.git` worktree pointer briefly leaked at the public origin before the rule was tightened. Current `.assetsignore` excludes `*.sql`, `*.sqlite*`, the `.git` file (and `.git/` directory form), `.dev.vars`, `src/`, `migrations/`, etc. Before any future deploy, sanity-check what `wrangler deploy` reports as new uploads.

**D.4.A (backend foundation).** Pure additive Worker change with no frontend wiring yet — sets the stage for the full D.4 event-sourcing cutover (plan: `~/.claude/plans/crispy-twirling-nest.md`).

- **`ALLOWED_TYPES` expanded** in [src/api/events.js](src/api/events.js) with 12 D.4.B types (`user.create`, `user.update`, `user.delete`, `block.reset`, `shift.swap-admin`, `shift.trade-admin`, `trade.offer-post`, `trade.offer-accept`, `trade.offer-decline`, `incentive.open-set`, `config.update`, `unavail.reason`) plus a `snapshot.bootstrap` placeholder. Allow-listing now lets the backend accept these events the moment the frontend starts emitting in D.4.B — no second deploy in the middle of that change.
- **`POST /api/events` response** now returns `{ id, serverTs }` (via `INSERT ... RETURNING server_ts`) instead of 204. `serverTs` is the canonical ordering key consumers will use as the `since` cursor.
- **`MAX_PAYLOAD_BYTES` bumped** 16 KB → 64 KB to absorb cascade payloads from `user.delete` / `block.reconcile` on long-tenured users.
- **`GET /api/events?gid=&since=&limit=&type=`** is the new event-tail endpoint. Auth = member of `gid`. Returns `{ events: [...], nextCursor: serverTs|null }`, ordered `(server_ts ASC, id ASC)`. Default `limit` 500, max 2000; soft 512 KB response cap. `nextCursor` is the last returned `serverTs` (inclusive) — consumers MUST dedupe by event `id` because `server_ts` is second-granularity and several events can share a tick.
- No schema migration: D1's `unixepoch()` is second-granularity but `id` is a TEXT PK with stable lexicographic comparison, so `(server_ts, id)` is a total order already.

Frontend is unchanged. No D.4.A behavior is visible to users — the only observable difference is that `POST /api/events` now returns JSON instead of 204, but the existing fire-and-forget callers ignore the response either way.

---

## Token efficiency rules

This is a hobby project on a personal token budget. Follow these rules to keep iterations cheap:

**Never read the wrong files**
- **`legacy/` is off-limits.** Never Read, never grep. v1/v2 are frozen archives kept only for git history.
- **Never Read `shyft-v3.html`** (the built artifact). It's regenerated by the build script and is just `head + JSX + tail` concatenated. To inspect content, Read `ShiftApp.v3.jsx` (or the head/tail templates). The *only* valid use of `shyft-v3.html` is the brace-count sanity pipe.
- **Never Read `Phases for Shyft and Rules for shift assignment.docx`, `Test logins.xlsx`, `svg code for logos.docx`, or any image** unless explicitly asked. They are large, binary-ish, and rarely useful for code work.

**Read large files in slices**
- `ShiftApp.v3.jsx` is ~7000 lines. **Always grep first** to find line numbers, then Read with `offset` + `limit`. A whole-file Read is almost always wasteful.
- Same rule applies to `templates/shyft_head.v3.html` (~600 lines) when in doubt.

**Filter your greps**
- Default include filters: `--include="*.jsx" --include="*.html" --include="*.md"`. This skips the .docx/.xlsx/.png assets, the simulators, and the test-logins file.
- Adding `--exclude-dir=legacy` belt-and-suspenders if grepping recursively.

**Don't repeat work**
- If you greped for a symbol earlier in the session and saw the line numbers, **don't grep for it again.** Note line numbers from earlier output and Read directly.
- After a rebuild, **don't Read the built artifact to verify.** The brace-count pipe + a targeted grep for new symbols is sufficient.

**Tool choice**
- For multi-occurrence renames, use `Edit` with `replace_all: true` (one tool call), not many small Edits.
- Skip `TodoWrite` for ≤3-step tasks.
- Prefer `Edit` (sends the diff) over `Write` (sends the whole file) when modifying existing files.

**Keep prose tight**
- Skip long preambles ("let me check X, then Y, then Z"). Just do it.
- For design discussions, cap proposed alternatives at ~3 short bullets each, not nested sub-lists.

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

### Marketplace (take-style trades)

```js
marketplace[i] = {
  id, dateKey, slotId, sellerId, incentivePts,
  postedAt, status: "open"|"taken"|"cancelled",
  takenBy?, takenAt?, autoPosted?, flagReason?
}
```

Reducers: `_postListing`, `postForTake`, `takeListing`, `cancelListing`. Listings appear in the **Trades** page (in nav for both providers and admin). Open count badged on nav. Two-sided swaps NOT implemented (only one-sided post-for-take).

---

## Coding conventions

- **Single-file React, no build tools.** Babel-standalone in the browser. JSX at runtime.
- **Tailwind via CDN** with extensions for `brand-*`, `ink-*`, `canvas`, `surface`, `shadow-card`. See head template.
- **Inter font.** Stat tiles use `tabular-nums` for alignment.
- **No external state libs.** Plain `useState`. Persistence via `window.storage` (a thin localStorage wrapper).
- **Compact code, dense comments.** The codebase favors slightly-dense JSX with explanatory comments above complex blocks rather than spreading things out. Match this style.
- **Source-tag awarded entries.** When awarding a shift, set `source` to one of: `pool` | `pool-solo` | `cascade` | `preferred-auto` | `available-auto` | `auto-swap` | `marketplace` | `admin`. The block report attributes by source.
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
- ✅ Calendar/ScheduleList read-only mode in Reconciliation+ (hide personal preferred/blocked overlays)
- ✅ Lock/Unlock confirm modals
- ✅ Block report (source-bucketed per-provider counts)
- ✅ Alerts module on admin dashboard
- ✅ **v3.1: Top Option model replacing per-slot pools**

### Pending (deferred by user)
- ⏳ **Lock-time point crediting** ("Step 2"). Today, points credit at reconcile via `users.points` directly. Spec wants `users.points` (locked balance) split from `pendingPoints[blockId]` (this block's accruals), with pending → locked at the Lock transition. Marketplace incentive points already move at take-time, but the snapshot-vs-live points distinction isn't fully wired.
- ⏳ Two-sided trades (swap my Friday for your Sunday). Currently only one-sided takes.
- ⏳ Admin-added incentive points on open shifts (separate from marketplace seller incentives).
- ⏳ Schedule snapshot at Lock (frozen "My final schedule" view per user, persisted with the block).

---

## Verification quick reference

Build + brace check + symbol presence:

```bash
# Run from the project root (the folder that contains ShiftApp.v3.jsx and templates/).
N=$(grep -n "^export default function ShiftApp" ShiftApp.v3.jsx | cut -d: -f1)
{ cat templates/shyft_head.v3.html; tail -n +"$N" ShiftApp.v3.jsx | sed 's/^export default function ShiftApp/function ShiftApp/'; cat templates/shyft_tail.v3.html; } > shyft-v3.html
o=$(grep -o '{' shyft-v3.html | wc -l) && c=$(grep -o '}' shyft-v3.html | wc -l) && echo "braces $o/$c"
```

Smoke test (open `shyft-v3.html` in browser):
1. Sign in as admin → Setup → create a block in Availability phase
2. Sign in as provider → Schedule → tap a day → 🎯 Top Option → bid + slot pref
3. Repeat for a few providers, some contested
4. Admin → Close & assign → verify report shows pool/cascade/auto rows
5. Provider → Mine → confirm one shift, flag another (try both auto-swap and no-candidate paths)
6. Trades page → take a listed shift as another provider
7. Admin → Lock block

---

## Working with the user (David)

- Prefers conversational design discussions before implementation. When proposing a change with multiple valid approaches, surface 2–3 alternatives.
- Builds incrementally. Each step should produce a working artifact.
- Wants the UI to remain simple for end users. Prefers consolidating duplicate concepts over adding more controls.
- Single-file React + Tailwind + babel-standalone is non-negotiable. Don't introduce a build tool.
- TodoWrite is welcome for multi-step features. Skip it for trivial changes.
- Plan mode is welcome for significant architectural changes — user often initiates with "go in to plan mode."
