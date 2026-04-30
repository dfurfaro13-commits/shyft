import React, { useState, useEffect, useMemo } from "react";

const DAYS_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAYS_LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const COLORS = ["#3B82F6","#8B5CF6","#EC4899","#10B981","#F59E0B","#EF4444","#06B6D4","#84CC16","#F97316","#A855F7"];
const UNAVAIL_REASONS = ["Working","Vacation","Conference","Personal Conflict"];

const DEFAULT_CONFIG = {
  // Multi-block model: `blocks` is an ordered list of scheduling windows.
  // Each block: { id, name, start, end, phase }. `currentBlockId` picks the active one.
  // `phase` is one of "availability" | "reconciliation" | "locked" — see PHASE constants.
  // Data (shifts, preferences, unavailability) is stored keyed by date, so old blocks stay readable.
  blocks: [], currentBlockId: null,
  // Legacy single-block fields — retained only for pre-multi-block migration on load.
  // `signupOpen` retained as a one-way migration source (true → "availability", false → "reconciliation").
  blockStart: "", blockEnd: "", signupOpen: false,
  shiftSlots: [
    { id: 1, name: "Primary", credit: 1.0, color: "#F59E0B" },
    { id: 2, name: "Backup", credit: 1.0, color: "#8B5CF6" },
  ],
  pointValues: { weekday: 1, fri: 2, sat: 3, sun: 2, holiday: 4 },
  pointValuesLocked: true, // admin must unlock before editing day-of-week point values
  holidays: {},
  seniorityLevels: [
    { id: 1, name: "Senior", minShifts: 2 },
    { id: 2, name: "Junior", minShifts: 3 },
  ],
  // Two distinct availability rules:
  //   1. Provider must PREFER (star) at least N days (and N weekend days). Falling short → penalty.
  //   2. Provider may BLOCK at most N days (and N weekend days). Going over → per-day penalty,
  //      and once their running total would dip below zero, they're forbidden from blocking more.
  minPreferredDays: 6, minPreferredWeekendDays: 2, preferredShortfallPenalty: 1,
  maxBlockedDays: 14, maxBlockedWeekendDays: 4, blockOverLimitPenalty: 1,
  involuntaryBonus: 1, nonPreferredBonus: 1,
};

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const dk = (y, m, d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const parseDk = k => { const [y,m,d] = k.split("-").map(Number); return new Date(y,m-1,d); };
const dim = (y, m) => new Date(y, m+1, 0).getDate();
const fdow = (y, m) => new Date(y, m, 1).getDay();
const initials = n => n.split(" ").map(s=>s[0]).join("").slice(0,2).toUpperCase();
const isWeekend = k => { const d = parseDk(k).getDay(); return d===0||d===6; };
const getUid = e => (typeof e==="object"&&e!==null)?(e.uid??null):e;
const isAuto = e => typeof e==="object"&&e!==null&&!!e.auto;
// v3.1 — entries are award-only. Pool/bid concept moved to per-day topOptions map; the legacy
// helpers (getPool, inPool, poolSize, getBid, setEntryBid, clearEntryBid, DEFAULT_BID) are gone.
// Component-level helpers replace them — see inTopOption/dayTopOptionerCount/getDayBid inside ShiftApp.
// Source tags on awarded entries: "pool" (top-bidder won), "pool-solo" (single Top-Optioner),
// "cascade" (took the other open slot after losing slot pref), "preferred-auto" / "available-auto"
// (auto-assign tier 1/2), "auto-swap" (replaced a flagged provider), "marketplace" (taken via the
// trade marketplace), "admin" (manual override). Legacy entries without a tag fall back to "unknown".
const getSource = e => {
  if(!e || !getUid(e)) return null;       // unfilled
  if(e.source) return e.source;
  if(isAuto(e)) return "unknown-auto";    // pre-source-tag auto entries
  return "unknown-manual";                // pre-source-tag manual entries
};

const dayPts = (date, cfg) => {
  const k = dk(date.getFullYear(), date.getMonth(), date.getDate());
  if (cfg.holidays[k]) return cfg.pointValues.holiday;
  const dow = date.getDay();
  if (dow===5) return cfg.pointValues.fri;
  if (dow===6) return cfg.pointValues.sat;
  if (dow===0) return cfg.pointValues.sun;
  return cfg.pointValues.weekday;
};

// Reads current block bounds from cfg.blocks[currentBlockId] (new model) or top-level
// cfg.blockStart/blockEnd (legacy fallback for pre-migration configs).
const currentBlockOf = cfg => {
  if(cfg.currentBlockId && Array.isArray(cfg.blocks)){
    const b = cfg.blocks.find(x => x.id === cfg.currentBlockId);
    if(b) return b;
  }
  // Legacy fallback: synthesize a block from pre-multitenant top-level fields. Map signupOpen
  // → phase ("availability" if open, otherwise "reconciliation" — closest semantic match).
  if(cfg.blockStart && cfg.blockEnd) {
    const phase = cfg.signupOpen ? "availability" : "reconciliation";
    return { id:"legacy", name:"Block", start:cfg.blockStart, end:cfg.blockEnd, phase };
  }
  return null;
};
const inBlock = (k, cfg) => { const b = currentBlockOf(cfg); return !!(b && k >= b.start && k <= b.end); };

const SUPER_BOOTSTRAP = "Shyft-Kai-Dave"; // bootstrap code required to create any new owner account
const gKey = (gid, k) => `g${gid}_${k}`;
const genCode = (len=6) => { const c="ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s=""; for(let i=0;i<len;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; };

export default function ShiftApp() {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [supers, setSupers] = useState([]);
  const [groupId, setGroupId] = useState(null);
  const [users, setUsers] = useState([]);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [shifts, setShifts] = useState({});
  const [unavailability, setUnavailability] = useState({});
  const [preferences, setPreferences] = useState({});
  // v3.1 simplification: per-day Top Option commitments. Replaces today's per-slot pools.
  // Shape: topOptions[dateKey] = { [uid]: { bid: number, slotPref: number|null } }
  // slotPref = a shift-slot id, or null/undefined = "Either". Bid is what the user spends if
  // they win a slot. Cleared when reconcile places the user (or when they walk away).
  const [topOptions, setTopOptions] = useState({});
  // v3.2: admin-set incentive points on open slots. Bonus pts are minted by the system on award.
  // Shape: openIncentives[dateKey] = { [slotId]: number_of_pts }. Cleared from the map when the
  // slot is awarded; awardee's users.points credits by the amount immediately (so they can spend it).
  const [openIncentives, setOpenIncentives] = useState({});
  // Trade-marketplace listings. Each: { id, dateKey, slotId, sellerId, incentivePts, postedAt,
  //   status: "open"|"taken"|"cancelled", takenBy?, takenAt?, autoPosted?, flagReason? }.
  // Group-scoped, persisted under shyft3_g{gid}_marketplace.
  const [marketplace, setMarketplace] = useState([]);
  // Per-shift confirm/flag UI: { dateKey, slotId } when the user is composing a flag reason.
  const [flagDraft, setFlagDraft] = useState(null);
  // Per-shift list-for-take UI: { dateKey, slotId, incentivePts } when composing a listing.
  const [listDraft, setListDraft] = useState(null);
  // Two-sided trade composer: { listingId, offererDateKey, offererSlotId, incentivePts } when
  // the current user is offering one of their shifts in exchange for someone else's listing.
  const [tradeDraft, setTradeDraft] = useState(null);
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("signin");
  const [authForm, setAuthForm] = useState({ username:"", password:"", name:"", groupCode:"", adminCode:"", superBootstrap:"" });
  const [authError, setAuthError] = useState("");
  const [groupForm, setGroupForm] = useState({ name:"" });
  const [toast, setToast] = useState("");
  const [page, setPage] = useState("home");
  const [calY, setCalY] = useState(new Date().getFullYear());
  const [calM, setCalM] = useState(new Date().getMonth());
  const [editingDay, setEditingDay] = useState(null);
  const [shiftsView, setShiftsView] = useState("list");
  const [availView, setAvailView] = useState("list");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [autoPreview, setAutoPreview] = useState(null);
  const [reconcilePreview, setReconcilePreview] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // Phase-transition confirms. confirmLock: admin moving from Reconciliation → Locked.
  // confirmRevert: admin moving from Reconciliation → Availability (wipes assignments).
  const [confirmLock, setConfirmLock] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  // { dateKey, penalty, projected } when the user is about to block past the allowed limit
  const [confirmBlockOver, setConfirmBlockOver] = useState(null);
  // Toggles the BlockReportModal (admin "Block report" action). The report itself is computed
  // on demand from current shifts, so we only need a boolean to drive open/close state.
  const [showBlockReport, setShowBlockReport] = useState(false);
  const [filterUid, setFilterUid] = useState(null);
  const [copied, setCopied] = useState(""); // SuperDashboard copy-to-clipboard feedback (hook must run on every render — Rules of Hooks)
  const [renamingGid, setRenamingGid] = useState(null); // SuperDashboard inline-rename: which group's name is being edited
  const [renameValue, setRenameValue] = useState("");   // SuperDashboard inline-rename: in-flight new-name input value
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserForm, setAddUserForm] = useState({ name:"", username:"", email:"", role:"provider", seniorityId:"", isTest:false });
  // After adminAddUser succeeds, this holds local credentials. If a cloud user was created
  // alongside (cloud-mirrored group + cloud-signed-in admin), `cloud` carries the cloud
  // credentials separately so the admin sees both options to share.
  const [newUserResult, setNewUserResult] = useState(null); // { name, username, tempPassword, email, role, cloud?: { email, kind, tempPassword } }

  // ── Phase A backend (cloud auth, magic-link sign-in, owner invite links).
  // Cloud session is purely additive: localStorage stays source of truth in Phase A.
  // Being signed-in to the cloud only enables (a) invite-link claiming, (b) mirroring new
  // groups to D1 so owners can issue cloud invite URLs. The local username/group-code flow
  // is unchanged.
  const [cloudUser, setCloudUser] = useState(null);          // { id, email, displayName, memberships: [...] } | null
  const [pendingInvite, setPendingInvite] = useState(null);  // { token, groupId, groupName, role, expiresAt } | null
  const [cloudEmail, setCloudEmail] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState("");
  // Phase D.2 migration UI: { localGroupId, name, users: [{name,email,tempPassword,role}] }
  // when the SuperDashboard's confirm-migration modal is open or showing the result.
  const [migrateState, setMigrateState] = useState(null);
  // Phase C: snapshot sync. cloudSyncOffer = { groupId, cloudGroupId, clientTs, serverTs } when
  // the cloud has data newer than this device's last persist for the active group.
  const [cloudSyncOffer, setCloudSyncOffer] = useState(null);
  // unclaimedCloudGroups = cloud groups in `cloudUser.memberships` that have no matching local
  // group (matched by cloudGroupId). Shown on the auth screen as "Restore" cards.
  const [unclaimedCloudGroups, setUnclaimedCloudGroups] = useState([]);
  const snapshotUploadTimer = useRef(null);
  const snapshotUploadInflight = useRef(false);

  useEffect(() => {
    (async () => {
      // Root-level (cross-group): groups list + super-admin accounts
      try { const r = await window.storage.get("groups",true).catch(()=>null); if(r) setGroups(JSON.parse(r.value)); } catch{}
      try { const r = await window.storage.get("supers",true).catch(()=>null); if(r) setSupers(JSON.parse(r.value)); } catch{}
      // Restore session
      let sess = null;
      try { const s = sessionStorage.getItem("shift_session"); if(s) sess = JSON.parse(s); } catch{}
      if(sess) setSession(sess);
      if(sess?.groupId){ await loadGroup(sess.groupId); }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cloud-session bootstrap. Runs once on mount, independent of the local-session effect above.
  // Parses ?invite=xxx out of the URL (and strips it from the address bar so refresh doesn't
  // re-trigger), then asks the API who we are. Failures are silent — the local app works fine
  // without a cloud session in Phase A.
  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const inviteToken = params.get("invite");
        if (inviteToken) {
          // Strip ?invite= from the URL while preserving any other query params.
          params.delete("invite");
          const qs = params.toString();
          const next = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
          window.history.replaceState({}, "", next);
          try {
            const inv = await window.api.fetchJSON("/api/invites/" + encodeURIComponent(inviteToken));
            if (inv) setPendingInvite(inv);
          } catch (e) { /* expired / used / not found — fall through silently */ }
        }
        try {
          const meRes = await window.api.fetchJSON("/api/me");
          if (meRes) setCloudUser(meRes);
        } catch (e) { /* not signed in — expected */ }
      } catch {}
    })();
  }, []);

  const loadGroup = async (gid) => {
    setGroupId(gid);
    try { const r = await window.storage.get(gKey(gid,"users"),true).catch(()=>null); setUsers(r?JSON.parse(r.value):[]); } catch{ setUsers([]); }
    try {
      const r = await window.storage.get(gKey(gid,"config"),true).catch(()=>null);
      if(r){
        const stored = JSON.parse(r.value);
        // Migrate: groups saved before pointValuesLocked existed get the new defaults + locked flag.
        if(stored.pointValuesLocked===undefined){
          stored.pointValues = {...DEFAULT_CONFIG.pointValues};
          stored.pointValuesLocked = true;
        }
        // Migrate legacy single-block (blockStart/blockEnd/signupOpen) → blocks[] with currentBlockId.
        // Also normalize: any block without `phase` gets one derived from its (legacy) signupOpen flag.
        if(!Array.isArray(stored.blocks) || stored.blocks.length===0){
          const blocks = [];
          if(stored.blockStart && stored.blockEnd){
            blocks.push({
              id: Date.now(),
              name: "Block 1",
              start: stored.blockStart,
              end: stored.blockEnd,
              phase: stored.signupOpen ? PHASE.AVAIL : PHASE.RECON,
            });
          }
          stored.blocks = blocks;
          stored.currentBlockId = blocks.length ? blocks[0].id : null;
        } else {
          stored.blocks = stored.blocks.map(b => {
            if (b && b.phase) return b;
            return { ...b, phase: b && b.signupOpen ? PHASE.AVAIL : PHASE.RECON };
          });
        }
        setConfig({...DEFAULT_CONFIG, ...stored});
      } else setConfig(DEFAULT_CONFIG);
    } catch{ setConfig(DEFAULT_CONFIG); }
    // Shifts + topOptions load. v3.1 migration: if any entry still carries a `pool` array,
    // walk them once and rebuild a `topOptions` map per day, then strip pool/bids from entries.
    // Idempotent — gated on a per-group localStorage marker.
    let loadedShifts = {};
    let loadedTopOptions = {};
    try { const r = await window.storage.get(gKey(gid,"shifts"),true).catch(()=>null); loadedShifts = r?JSON.parse(r.value):{}; } catch{ loadedShifts = {}; }
    try { const r = await window.storage.get(gKey(gid,"topOptions"),true).catch(()=>null); loadedTopOptions = r?JSON.parse(r.value):{}; } catch{ loadedTopOptions = {}; }
    {
      const migMarker = `shyft3_g${gid}_migrate_top_options`;
      const alreadyMigrated = localStorage.getItem(migMarker) === "done";
      let anyPoolFound = false;
      const nextTops = {...loadedTopOptions};
      const nextShifts = {};
      for(const [k, day] of Object.entries(loadedShifts)){
        nextShifts[k] = {};
        for(const [sidStr, e] of Object.entries(day)){
          const sid = parseInt(sidStr);
          if(e && Array.isArray(e.pool) && e.pool.length){
            anyPoolFound = true;
            if(!nextTops[k]) nextTops[k] = {};
            for(const uid of e.pool){
              if(uid === e.uid) continue; // already awarded
              const bid = (e.bids && uid in e.bids) ? e.bids[uid] : 1;
              const cur = nextTops[k][uid];
              // If user appears in multiple legacy slot pools, keep highest bid + first slotPref.
              if(!cur || (bid > cur.bid)) nextTops[k][uid] = { bid, slotPref: cur?.slotPref ?? sid };
            }
          }
          // Strip pool/bids regardless — entries are award-only in the new model.
          const { pool, bids, ...rest } = e || {};
          // Drop empty entries entirely (no winner, no metadata worth keeping)
          if(rest.uid || rest.source || rest.confirm || rest.flagReason || rest.swappedFrom || rest.takenFrom){
            nextShifts[k][sid] = rest;
          }
        }
        if(!Object.keys(nextShifts[k]).length) delete nextShifts[k];
      }
      if(anyPoolFound && !alreadyMigrated){
        // Persist migrated shape (overwrite legacy data) and stamp marker.
        try { await window.storage.set(gKey(gid,"shifts"), JSON.stringify(nextShifts), true); } catch {}
        try { await window.storage.set(gKey(gid,"topOptions"), JSON.stringify(nextTops), true); } catch {}
        localStorage.setItem(migMarker, "done");
        loadedShifts = nextShifts;
        loadedTopOptions = nextTops;
      } else if(!alreadyMigrated){
        localStorage.setItem(migMarker, "done");
      }
    }
    setShifts(loadedShifts);
    setTopOptions(loadedTopOptions);
    try {
      const r = await window.storage.get(gKey(gid,"unavail"),true).catch(()=>null);
      if(r){
        const raw=JSON.parse(r.value), mig={};
        Object.entries(raw).forEach(([uid,v])=>{ mig[uid]=Array.isArray(v)?Object.fromEntries(v.map(k=>[k,null])):(v||{}); });
        setUnavailability(mig);
      } else setUnavailability({});
    } catch{ setUnavailability({}); }
    try { const r = await window.storage.get(gKey(gid,"prefs"),true).catch(()=>null); setPreferences(r?JSON.parse(r.value):{}); } catch{ setPreferences({}); }
    try { const r = await window.storage.get(gKey(gid,"marketplace"),true).catch(()=>null); setMarketplace(r?JSON.parse(r.value):[]); } catch{ setMarketplace([]); }
    try { const r = await window.storage.get(gKey(gid,"openIncentives"),true).catch(()=>null); setOpenIncentives(r?JSON.parse(r.value):{}); } catch{ setOpenIncentives({}); }
  };

  // Group-scoped persistence: writes under shyft_g{gid}_{key}. Root-level writes use persistRoot.
  const persist = async (key, val) => {
    if(!groupId){ /* called before a group is active — ignore to avoid leaking into root keys */ return; }
    try { await window.storage.set(gKey(groupId,key), JSON.stringify(val), true); } catch { flash("⚠️ Save failed"); }
    // Phase C: stamp a local-modified time and schedule a debounced cloud snapshot.
    try { localStorage.setItem(`shyft3_g${groupId}_lastModified`, String(Date.now())); } catch {}
    scheduleSnapshotUpload();
  };
  const persistRoot = async (key, val) => {
    try { await window.storage.set(key, JSON.stringify(val), true); } catch { flash("⚠️ Save failed"); }
  };

  const flash = msg => { setToast(msg); setTimeout(()=>setToast(""),2800); };
  const me = useMemo(() => {
    if(!session) return null;
    if(session.superId){ const s = supers.find(x=>x.id===session.superId); return s?{...s, role:"super"}:null; }
    if(session.userId){ return users.find(u=>u.id===session.userId) || null; }
    return null;
  }, [session, users, supers]);
  const currentGroup = useMemo(() => groupId?groups.find(g=>g.id===groupId):null, [groupId, groups]);
  const mySeniority = useMemo(() => me?.seniorityId ? config.seniorityLevels.find(l=>l.id===me.seniorityId) : null, [me, config]);

  // Active block: drives which dates the UI treats as "in-block" (signup, calendar highlighting, counters).
  const currentBlock = useMemo(() => currentBlockOf(config), [config]);

  const blockDays = useMemo(() => {
    if (!currentBlock) return [];
    const out = [];
    for (let d=parseDk(currentBlock.start); d<=parseDk(currentBlock.end); d.setDate(d.getDate()+1))
      out.push(dk(d.getFullYear(),d.getMonth(),d.getDate()));
    return out;
  }, [currentBlock]);

  const blockWeekendDays = useMemo(() => blockDays.filter(isWeekend), [blockDays]);

  // Auto-raise a provider's personal minimum to the floor set by their seniority.
  // Runs whenever the seniority floor changes; providers can't set min below this.
  useEffect(() => {
    if(!me||me.role!=="provider") return;
    const floor = mySeniority?.minShifts||0;
    if(floor<=0) return;
    const t = me.targets||{min:0,ideal:0,max:0};
    if((t.min||0)<floor){
      updateUser(me.id, { targets: {...t, min: floor} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, mySeniority?.minShifts]);

  /* ── Auth ── */
  const handleAuth = async () => {
    setAuthError("");
    const username = authForm.username.trim().toLowerCase();
    const pw = authForm.password;
    if (!username||!pw) { setAuthError("Username and password required"); return; }
    const pwHash = await sha256(pw);

    if (authMode==="signin") {
      // Search: first all groups' user rosters, then the super pool.
      for(const g of groups){
        try {
          const r = await window.storage.get(gKey(g.id,"users"),true).catch(()=>null);
          const list = r?JSON.parse(r.value):[];
          const u = list.find(x=>x.username===username);
          if(u){
            if(u.passwordHash!==pwHash){ setAuthError("Wrong password"); return; }
            await loadGroup(g.id);
            const sess = {groupId:g.id, userId:u.id}; setSession(sess); sessionStorage.setItem("shift_session",JSON.stringify(sess));
            setAuthForm({username:"",password:"",name:"",groupCode:"",adminCode:"",superBootstrap:""}); setPage("home");
            return;
          }
        } catch{}
      }
      const sup = supers.find(s=>s.username===username);
      if(sup){
        if(sup.passwordHash!==pwHash){ setAuthError("Wrong password"); return; }
        const sess = {superId:sup.id}; setSession(sess); sessionStorage.setItem("shift_session",JSON.stringify(sess));
        setAuthForm({username:"",password:"",name:"",groupCode:"",adminCode:"",superBootstrap:""}); setPage("home");
        return;
      }
      setAuthError("No account found with that username"); return;
    }

    if (authMode==="signup") {
      const gCode = authForm.groupCode.trim().toUpperCase();
      if(!gCode){ setAuthError("Group code required"); return; }
      const group = groups.find(g=>g.groupCode===gCode);
      if(!group){ setAuthError("Invalid group code"); return; }
      if(!authForm.name.trim()){ setAuthError("Name required"); return; }
      if(pw.length<4){ setAuthError("Password must be 4+ chars"); return; }
      // Optional admin code: if present, validate; if invalid, error.
      const adminCode = authForm.adminCode.trim().toUpperCase();
      let role = "provider";
      if(adminCode){
        if(adminCode!==group.adminCode){ setAuthError("Invalid admin code"); return; }
        role = "admin";
      }
      // Load group's users to validate uniqueness
      let gUsers = [];
      try { const r = await window.storage.get(gKey(group.id,"users"),true).catch(()=>null); gUsers = r?JSON.parse(r.value):[]; } catch{}
      if(gUsers.find(u=>u.username===username)){ setAuthError("Username taken in this group"); return; }
      const nu = { id:Date.now(), username, passwordHash:pwHash,
        name:authForm.name.trim(), role, seniorityId:null, points:0,
        targets:{min:0,ideal:0,max:0}, createdAt:Date.now() };
      const next = [...gUsers,nu];
      await window.storage.set(gKey(group.id,"users"), JSON.stringify(next), true).catch(()=>{});
      await loadGroup(group.id);
      setUsers(next); // ensure in-memory reflects the just-added user even if loadGroup hasn't finished
      const sess = {groupId:group.id, userId:nu.id}; setSession(sess); sessionStorage.setItem("shift_session",JSON.stringify(sess));
      setAuthForm({username:"",password:"",name:"",groupCode:"",adminCode:"",superBootstrap:""}); setPage("home");
      if(role==="provider") setShowOnboarding(true);
      flash(role==="admin"?`👑 Admin of ${group.name}`:`✅ Joined ${group.name}`);
      return;
    }

    if (authMode==="super") {
      if(!authForm.name.trim()){ setAuthError("Name required"); return; }
      if(pw.length<4){ setAuthError("Password must be 4+ chars"); return; }
      const bs = authForm.superBootstrap.trim();
      if(bs!==SUPER_BOOTSTRAP){ setAuthError("Invalid owner bootstrap code"); return; }
      if(supers.find(s=>s.username===username)){ setAuthError("Username already registered as owner"); return; }
      const ns = { id:Date.now(), username, passwordHash:pwHash, name:authForm.name.trim(), createdAt:Date.now() };
      const next = [...supers,ns]; setSupers(next); await persistRoot("supers",next);
      const sess = {superId:ns.id}; setSession(sess); sessionStorage.setItem("shift_session",JSON.stringify(sess));
      setAuthForm({username:"",password:"",name:"",groupCode:"",adminCode:"",superBootstrap:""}); setPage("home");
      flash(`🛠 Owner account created`);
      return;
    }
  };

  const signOut = () => {
    setSession(null); sessionStorage.removeItem("shift_session");
    setGroupId(null); setUsers([]); setConfig(DEFAULT_CONFIG); setShifts({}); setUnavailability({}); setPreferences({});
    setPage("home");
  };

  /* ── Phase A cloud helpers ── */
  // Request a magic-link email. Used by the auth-screen Cloud tab and the invite-claim flow.
  const requestMagicLink = async (email, inviteToken) => {
    setCloudBusy(true); setCloudError("");
    try {
      await window.api.fetchJSON("/api/auth/request", {
        method: "POST",
        body: JSON.stringify({ email: (email||"").trim().toLowerCase(), inviteToken: inviteToken || undefined }),
      });
      setMagicLinkSent(true);
    } catch (e) {
      setCloudError(e?.body?.error === "rate_limited"
        ? "Too many requests. Try again in an hour."
        : (e?.body?.error === "invalid_invite"
          ? "Invite link is invalid or expired."
          : "Couldn't send the link. Try again."));
    } finally { setCloudBusy(false); }
  };
  // Phase D.1: password sign-in for test users (and optionally real users who set one).
  // Same session cookie as magic-link, so success path behaves identically.
  const signInWithPassword = async (email, password) => {
    setCloudBusy(true); setCloudError("");
    try {
      await window.api.fetchJSON("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ email: (email||"").trim().toLowerCase(), password }),
      });
      // Refresh /api/me so cloudUser reflects the new session immediately.
      try { const meRes = await window.api.fetchJSON("/api/me"); if (meRes) setCloudUser(meRes); } catch {}
      setCloudPassword("");
    } catch (e) {
      setCloudError(e?.body?.error === "rate_limited"
        ? "Too many attempts. Try again in an hour."
        : "Email or password is incorrect.");
    } finally { setCloudBusy(false); }
  };
  const signOutCloud = async () => {
    try { await window.api.fetchJSON("/api/auth/logout", { method: "POST" }); } catch {}
    setCloudUser(null);
  };
  // Owner-only: mint an invite URL for a cloud-mirrored group, copy to clipboard.
  const createCloudInvite = async (cloudGroupId) => {
    try {
      const r = await window.api.fetchJSON("/api/groups/" + encodeURIComponent(cloudGroupId) + "/invites", {
        method: "POST",
        body: JSON.stringify({ role: "provider" }),
      });
      try { await navigator.clipboard.writeText(r.url); } catch {}
      flash("✅ Invite link copied to clipboard");
      return r.url;
    } catch (e) {
      flash("⚠️ Couldn't create invite link");
      return null;
    }
  };

  // Phase C: snapshot upload + download helpers.
  //
  // The snapshot is the entire per-group state plus the local-only group metadata
  // (groupCode, adminCode, etc.) bundled together so a different device can fully recreate
  // the group from cloud.
  const buildSnapshotPayload = (gid) => {
    const g = groups.find(x => x.id === gid);
    if (!g) return null;
    return {
      meta: {
        name: g.name,
        groupCode: g.groupCode,
        adminCode: g.adminCode,
        createdAt: g.createdAt,
        cloudGroupId: g.cloudGroupId,
      },
      users, config,
      shifts, unavail: unavailability, prefs: preferences,
      marketplace, topOptions, openIncentives,
    };
  };

  const uploadSnapshot = async () => {
    if (!cloudUser || !currentGroup?.cloudGroupId || !groupId) return;
    if (snapshotUploadInflight.current) return;
    snapshotUploadInflight.current = true;
    try {
      const payload = buildSnapshotPayload(groupId);
      if (!payload) return;
      const clientTs = Date.now();
      try { localStorage.setItem(`shyft3_g${groupId}_lastModified`, String(clientTs)); } catch {}
      await window.api.fetchJSON("/api/snapshots", {
        method: "POST",
        body: JSON.stringify({ groupId: currentGroup.cloudGroupId, payload, clientTs }),
      });
    } catch {} finally {
      snapshotUploadInflight.current = false;
    }
  };
  const scheduleSnapshotUpload = () => {
    if (!cloudUser || !currentGroup?.cloudGroupId) return;
    if (snapshotUploadTimer.current) clearTimeout(snapshotUploadTimer.current);
    snapshotUploadTimer.current = setTimeout(uploadSnapshot, 2000);
  };

  // Apply a snapshot payload to localStorage and React state for a given local groupId.
  // Used by both the in-group "sync from cloud" banner and the first-device-claim flow.
  const applySnapshot = async (gid, payload) => {
    if (!payload) return;
    const writeKey = (k, v) => { try { localStorage.setItem(`shyft3_${gKey(gid,k)}`, JSON.stringify(v)); } catch {} };
    writeKey("users", payload.users || []);
    writeKey("config", payload.config || DEFAULT_CONFIG);
    writeKey("shifts", payload.shifts || {});
    writeKey("unavail", payload.unavail || {});
    writeKey("prefs", payload.prefs || {});
    writeKey("marketplace", payload.marketplace || []);
    writeKey("topOptions", payload.topOptions || {});
    writeKey("openIncentives", payload.openIncentives || {});
    // If the calling group is the active one, refresh React state so the UI reflects the new data.
    if (gid === groupId) await loadGroup(gid);
  };

  // Pull /api/snapshots/:cloudGroupId/latest and decide whether to offer a sync. Called after
  // loadGroup completes for any cloud-mirrored group.
  const checkCloudSyncOffer = async (gid, cloudGid) => {
    if (!cloudUser || !cloudGid) return;
    let snap = null;
    try { snap = await window.api.fetchJSON("/api/snapshots/" + encodeURIComponent(cloudGid) + "/latest"); }
    catch (e) { return; /* 404 = no remote yet, ignore */ }
    if (!snap?.payload) return;
    let localTs = 0;
    try { localTs = parseInt(localStorage.getItem(`shyft3_g${gid}_lastModified`)||"0", 10) || 0; } catch {}
    if ((snap.clientTs||0) > localTs + 1000) {
      // Cloud is meaningfully newer (1s slack to avoid loop on round-trips).
      setCloudSyncOffer({ groupId: gid, cloudGroupId: cloudGid, clientTs: snap.clientTs, serverTs: snap.serverTs, payload: snap.payload });
    }
  };
  const acceptCloudSync = async () => {
    if (!cloudSyncOffer) return;
    await applySnapshot(cloudSyncOffer.groupId, cloudSyncOffer.payload);
    try { localStorage.setItem(`shyft3_g${cloudSyncOffer.groupId}_lastModified`, String(cloudSyncOffer.clientTs)); } catch {}
    setCloudSyncOffer(null);
    flash("✅ Synced from cloud");
  };

  // First-device-claim: build the list of cloud groups (from cloudUser.memberships) that don't
  // have a corresponding local group. Recomputed whenever cloudUser or groups change.
  useEffect(() => {
    if (!cloudUser?.memberships?.length) { setUnclaimedCloudGroups([]); return; }
    const localCloudGids = new Set(groups.map(g => g.cloudGroupId).filter(Boolean));
    setUnclaimedCloudGroups(cloudUser.memberships.filter(m => !localCloudGids.has(m.groupId)));
  }, [cloudUser, groups]);

  // After a group is loaded AND cloud session is known, check whether the cloud has newer data.
  // Re-runs whenever the active group changes or the cloud session boots.
  useEffect(() => {
    if (!groupId || !cloudUser || !currentGroup?.cloudGroupId) { setCloudSyncOffer(null); return; }
    checkCloudSyncOffer(groupId, currentGroup.cloudGroupId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, cloudUser, currentGroup?.cloudGroupId]);

  // Phase D.2: read a non-active group's full state from localStorage so we can ship it
  // up during migration. (`buildSnapshotPayload` only works for the active group because
  // it sources from React state.)
  const readGroupStateFromStorage = (gid) => {
    const read = (k, fallback) => {
      try { const raw = localStorage.getItem(`shyft3_${gKey(gid, k)}`); return raw ? JSON.parse(raw) : fallback; }
      catch { return fallback; }
    };
    return {
      users: read("users", []),
      config: read("config", DEFAULT_CONFIG),
      shifts: read("shifts", {}),
      unavail: read("unavail", {}),
      prefs: read("prefs", {}),
      marketplace: read("marketplace", []),
      topOptions: read("topOptions", {}),
      openIncentives: read("openIncentives", {}),
    };
  };

  // Open the confirm-migrate modal for a local-only group.
  const startMigrateGroup = (g) => {
    if (!cloudUser) { flash("⚠️ Sign in to cloud first"); return; }
    const state = readGroupStateFromStorage(g.id);
    setMigrateState({
      phase: "confirm",
      group: g,
      localUsers: state.users || [],
      payload: {
        meta: {
          name: g.name,
          groupCode: g.groupCode,
          adminCode: g.adminCode,
          createdAt: g.createdAt,
          cloudGroupId: g.cloudGroupId,
        },
        ...state,
      },
    });
  };
  const cancelMigrate = () => setMigrateState(null);
  // Confirm + perform the migration. On success, the local group gets a cloudGroupId and the
  // modal flips to "result" mode, listing each migrated user's synthetic email + temp password.
  const confirmMigrate = async () => {
    if (!migrateState || migrateState.phase !== "confirm") return;
    const g = migrateState.group;
    try {
      const r = await window.api.fetchJSON(`/api/groups/${encodeURIComponent(String(g.id))}/migrate`, {
        method: "POST",
        body: JSON.stringify({
          name: g.name,
          snapshot: migrateState.payload,
          users: (migrateState.localUsers || []).map(u => ({ localId: String(u.id), name: u.name, role: u.role })),
          clientTs: Date.now(),
        }),
      });
      // Persist cloudGroupId on the local group entry so subsequent snapshot uploads
      // (and the "is migrated?" UI gating) work.
      const next = groups.map(x => x.id === g.id ? { ...x, cloudGroupId: r.cloudGroupId } : x);
      setGroups(next); await persistRoot("groups", next);
      // Refresh memberships so cloudUser includes the newly-owned group.
      try { const meRes = await window.api.fetchJSON("/api/me"); if (meRes) setCloudUser(meRes); } catch {}
      // Stamp lastModified for the migrated group so future cloud-sync-offer checks skip it.
      try { localStorage.setItem(`shyft3_g${g.id}_lastModified`, String(Date.now())); } catch {}
      setMigrateState({ phase: "result", group: { ...g, cloudGroupId: r.cloudGroupId }, result: r });
    } catch (e) {
      flash("⚠️ Migration failed: " + (e?.message || "unknown"));
      setMigrateState(null);
    }
  };

  // Pull a snapshot from cloud and create a fresh local group entry from its meta.
  // The user will need their existing local username/password (saved in the snapshot's `users`)
  // to actually sign in — this only restores the data, not the session.
  const claimCloudGroup = async (cloudGid, cloudGroupName) => {
    let snap = null;
    try { snap = await window.api.fetchJSON("/api/snapshots/" + encodeURIComponent(cloudGid) + "/latest"); }
    catch (e) { flash("⚠️ This group has no cloud snapshot yet — open it on your other device first"); return; }
    if (!snap?.payload) { flash("⚠️ Empty cloud snapshot"); return; }
    const meta = snap.payload.meta || {};
    const newId = Date.now();
    const ng = {
      id: newId,
      name: meta.name || cloudGroupName || "Restored group",
      groupCode: meta.groupCode || genCode(6),
      adminCode: meta.adminCode || genCode(6),
      createdAt: meta.createdAt || Date.now(),
      cloudGroupId: cloudGid,
    };
    const next = [...groups, ng];
    setGroups(next); await persistRoot("groups", next);
    await applySnapshot(newId, snap.payload);
    try { localStorage.setItem(`shyft3_g${newId}_lastModified`, String(snap.clientTs)); } catch {}
    flash(`✅ "${ng.name}" restored — sign in with your existing credentials`);
  };

  // Phase B: append-only event log helper. Fire-and-forget. No-op when the user isn't
  // cloud-signed-in or the active group hasn't been mirrored to D1. Errors are swallowed
  // — localStorage is still source of truth, so a failed log only loses ML signal.
  const trackEvent = (type, payload, opts = {}) => {
    if (!cloudUser || !currentGroup?.cloudGroupId) return;
    const body = {
      groupId: currentGroup.cloudGroupId,
      type,
      payload: payload || {},
      localUid: me?.id || null,
      blockId: opts.blockId ?? (currentBlock?.id != null ? String(currentBlock.id) : null),
      clientTs: Date.now(),
    };
    window.api.fetchJSON("/api/events", { method: "POST", body: JSON.stringify(body) }).catch(()=>{});
  };

  /* ── Super-admin helpers ── */
  const createGroup = async (name) => {
    const existingCodes = new Set(groups.flatMap(g=>[g.groupCode, g.adminCode]));
    let gc, ac;
    do { gc = genCode(6); } while(existingCodes.has(gc));
    do { ac = genCode(6); } while(existingCodes.has(ac) || ac===gc);
    const ng = { id:Date.now(), name:name.trim()||"Untitled group", groupCode:gc, adminCode:ac, createdAt:Date.now() };
    // If we have a cloud session, mirror the new group to D1 and stash its cloud id on the local
    // group object so the owner can issue cloud invite links. Non-blocking: a failure here doesn't
    // prevent the local group from being created — it just means no cloud invites for this group
    // until we add a retry path in a later phase.
    if (cloudUser) {
      try {
        const r = await window.api.fetchJSON("/api/groups", {
          method: "POST",
          body: JSON.stringify({ name: ng.name }),
        });
        if (r?.groupId) ng.cloudGroupId = r.groupId;
        // Refresh memberships so the new group shows up in `cloudUser.memberships`.
        try { const meRes = await window.api.fetchJSON("/api/me"); if (meRes) setCloudUser(meRes); } catch {}
      } catch (e) { flash("⚠️ Group created locally, but cloud mirror failed"); }
    }
    const next = [...groups, ng]; setGroups(next); await persistRoot("groups", next);
    flash(`✅ Group "${ng.name}" created`);
    return ng;
  };
  const deleteGroup = async (gid) => {
    const g = groups.find(x=>x.id===gid); if(!g) return;
    if(!confirm(`Delete group "${g.name}" and all of its data? This cannot be undone.`)) return;
    // Purge per-group keys. Uses shyft3_ prefix to match window.storage shim, and includes
    // every v3-era key (marketplace, topOptions, openIncentives) plus the per-group migration
    // marker so a deletion leaves no orphans behind.
    for(const k of ["users","config","shifts","unavail","prefs","marketplace","topOptions","openIncentives"]){
      try { localStorage.removeItem("shyft3_"+gKey(gid,k)); } catch{}
    }
    try { localStorage.removeItem(`shyft3_g${gid}_migrate_top_options`); } catch{}
    const next = groups.filter(x=>x.id!==gid); setGroups(next); await persistRoot("groups", next);
    flash(`🗑 Group "${g.name}" deleted`);
  };

  /* ── Points ── */
  // All per-user counters scope to the current block's dates. Historical block data lives in
  // the same shifts dict but is ignored here — carryover into user.points is the admin's job.
  const getPtsEarned = uid => {
    let t=0;
    Object.entries(shifts).forEach(([k,day])=>{
      if(!inBlock(k,config)) return;
      const base=dayPts(parseDk(k),config);
      const wasPref=(preferences[uid]||[]).includes(k);
      Object.entries(day).forEach(([sid,entry])=>{
        if(getUid(entry)===uid){
          const slot=config.shiftSlots.find(s=>s.id===parseInt(sid));
          t += base*(slot?.credit||1);
          if(isAuto(entry)){
            t += (config.involuntaryBonus||0);
            if(!wasPref) t += (config.nonPreferredBonus||0);
          }
        }
      });
    });
    return t;
  };

  const getShiftCount = uid => { let n=0; Object.entries(shifts).forEach(([k,d])=>{if(!inBlock(k,config))return;Object.values(d).forEach(e=>{if(getUid(e)===uid)n++;});}); return n; };
  const getAutoCount = uid => { let n=0; Object.entries(shifts).forEach(([k,d])=>{if(!inBlock(k,config))return;Object.values(d).forEach(e=>{if(getUid(e)===uid&&isAuto(e))n++;});}); return n; };
  // Auto-assigned shifts on dates the user didn't mark as preferred (they also didn't block — never auto-assigned to blocked).
  const getAutoNonPrefCount = uid => { let n=0; Object.entries(shifts).forEach(([k,d])=>{if(!inBlock(k,config))return;const pref=(preferences[uid]||[]).includes(k);Object.values(d).forEach(e=>{if(getUid(e)===uid&&isAuto(e)&&!pref)n++;});}); return n; };

  // Combined availability scorecard. Two independent checks:
  //   • Preferred-shortfall: not enough ⭐ preferred days (or weekend pref days) → flat per-shortfall penalty.
  //   • Block-overage: too many blocked days (or weekend blocks) → per-extra-day penalty.
  // Both penalties are summed into `penalty`. `meets` is the AND of both checks passing.
  const getAvailInfo = uid => {
    const blocked = Object.keys(unavailability[uid]||{}).filter(d=>inBlock(d,config));
    const blockedWk = blocked.filter(isWeekend);
    const availD = blockDays.length - blocked.length;
    const availW = blockWeekendDays.length - blockedWk.length;
    // Preferred-day check — the union of explicit ⭐ Preferred dates AND any 🎯 Top Option dates.
    // Today setTopOption auto-marks the day preferred so this union is redundant in practice, but
    // counting both directly makes the requirement check robust against future codepaths that might
    // bypass that auto-mark, and matches the user's stated mental model ("both should count").
    const prefSet = new Set((preferences[uid]||[]).filter(d=>inBlock(d,config)));
    Object.keys(topOptions).forEach(d => { if(inBlock(d,config) && topOptions[d]?.[uid]) prefSet.add(d); });
    const pref = [...prefSet];
    const prefWk = pref.filter(isWeekend);
    const prefShort = Math.max(0, (config.minPreferredDays||0) - pref.length);
    const prefWkShort = Math.max(0, (config.minPreferredWeekendDays||0) - prefWk.length);
    const prefShortPenalty = (prefShort + prefWkShort) * (config.preferredShortfallPenalty||0);
    // Block-overage check
    const blockOver = Math.max(0, blocked.length - (config.maxBlockedDays||Infinity));
    const blockWkOver = Math.max(0, blockedWk.length - (config.maxBlockedWeekendDays||Infinity));
    const blockPenalty = (blockOver + blockWkOver) * (config.blockOverLimitPenalty||0);
    const penalty = prefShortPenalty + blockPenalty;
    const prefMeets = prefShort===0 && prefWkShort===0;
    const blockMeets = blockOver===0 && blockWkOver===0;
    return {
      blocked:blocked.length, blockedWk:blockedWk.length, availD, availW,
      pref:pref.length, prefWk:prefWk.length,
      prefShort, prefWkShort, prefShortPenalty,
      blockOver, blockWkOver, blockPenalty,
      penalty, prefMeets, blockMeets, meets: prefMeets && blockMeets,
      // Legacy aliases so any unmigrated callsite still reads something reasonable.
      dayShort: prefShort, wkShort: prefWkShort,
    };
  };

  // Capacity check used before letting a provider block another day.
  // Returns one of:
  //   { kind:"ok" }                                — under the limit (no penalty)
  //   { kind:"over", penalty, projected }          — over the limit, penalty would still leave totalPts ≥ 0
  //   { kind:"forbidden", penalty, projected }     — over the limit AND totalPts would dip below 0 → block disallowed
  const checkBlockCapacity = (uid, dateKey) => {
    const isWk = isWeekend(dateKey);
    const a = getAvailInfo(uid);
    const wouldBeBlocked = a.blocked + 1;
    const wouldBeBlockedWk = a.blockedWk + (isWk ? 1 : 0);
    const newOver = Math.max(0, wouldBeBlocked - (config.maxBlockedDays||Infinity));
    const newWkOver = Math.max(0, wouldBeBlockedWk - (config.maxBlockedWeekendDays||Infinity));
    // Marginal extra penalty this single block would introduce
    const extraOver = newOver - a.blockOver;
    const extraWkOver = newWkOver - a.blockWkOver;
    const extraPenalty = (extraOver + extraWkOver) * (config.blockOverLimitPenalty||0);
    if (extraPenalty <= 0) return { kind:"ok", penalty:0 };
    const currentTotal = totalPts(uid);
    const projected = currentTotal - extraPenalty;
    if (projected < 0) return { kind:"forbidden", penalty:extraPenalty, projected };
    return { kind:"over", penalty:extraPenalty, projected };
  };

  // Spendable / tiebreak points = bank balance minus availability penalties.
  // Crucially, this does NOT include points "earned" from awards in the current block — those
  // aren't credited until the block is locked (Phase 3 close in the spec). Until then, the user
  // can only bid what they actually have. `getPtsEarned` is still available as a projection
  // ("you'd earn N pts if everything sticks") and is used for display, not for bidding.
  const totalPts = uid => {
    const u = users.find(x=>x.id===uid);
    return (u?.points||0) - getAvailInfo(uid).penalty;
  };
  // Snapshot of users.points captured at the moment signup closes, stored on the block as
  // `block.pointsAtClose = {uid: pts}`. computeReconcile uses this as the base for tiebreaks
  // so a re-reconcile (after admin reset+reclose) still ranks against entering-block points.
  // Falls back to live users.points when no snapshot exists (open signup, or legacy blocks).
  const snapshotPtsForReconcile = uid => {
    const u = users.find(x=>x.id===uid);
    const snap = currentBlock?.pointsAtClose;
    const base = (snap && uid in snap) ? snap[uid] : (u?.points || 0);
    return base - getAvailInfo(uid).penalty;
  };

  // Block report — derived live from the current shifts state for the active block.
  // Buckets every awarded entry by its `source` tag, plus tallies open-vs-pending slots
  // and produces a per-provider breakdown with min/ideal/max comparison. Powers the
  // dashboard "Block report" button and the per-provider history view.
  const getBlockReport = () => {
    const provs = users.filter(u => u.role === "provider");
    const totalSlots = blockDays.length * config.shiftSlots.length;
    const SOURCES = ["pool","cascade","preferred-auto","available-auto","admin","unknown-auto","unknown-manual"];
    const bySource = Object.fromEntries(SOURCES.map(s=>[s,0]));
    let openSlots = 0, pendingPool = 0;
    const perUser = {};
    provs.forEach(p => { perUser[p.id] = Object.fromEntries(SOURCES.map(s=>[s,0])); perUser[p.id].total = 0; });
    for(const k of blockDays){
      const day = shifts[k] || {};
      const dayHasTops = dayTopOptionerCount(k) > 0;
      for(const slot of config.shiftSlots){
        const e = day[slot.id];
        if(!e || !getUid(e)){
          // v3.1: an open slot is "pending pool" when there's at least one Top Option for the day.
          if(dayHasTops) pendingPool++;
          else openSlots++;
          continue;
        }
        const src = getSource(e) || "unknown-manual";
        bySource[src] = (bySource[src]||0) + 1;
        const uid = getUid(e);
        if(perUser[uid]){
          perUser[uid][src] = (perUser[uid][src]||0) + 1;
          perUser[uid].total++;
        }
      }
    }
    const perUserRows = provs.map(p => {
      const min = (config.seniorityLevels.find(l => l.id === p.seniorityId)?.minShifts) || 0;
      const ideal = p.targets?.ideal || 0;
      const max = p.targets?.max || 0;
      const row = perUser[p.id];
      return { user:p, ...row, min, ideal, max };
    }).sort((a,b) => b.total - a.total || a.user.name.localeCompare(b.user.name));
    return { totalSlots, bySource, openSlots, pendingPool, perUserRows };
  };

  /* ── Shift actions ── */
  const isUnavail = (uid,k) => !!(unavailability[uid] && k in unavailability[uid]);
  const unavailReason = (uid,k) => (unavailability[uid]||{})[k] || null;
  const isWanted = (uid,k) => (preferences[uid]||[]).includes(k);
  const wantedCount = uid => (preferences[uid]||[]).filter(d=>inBlock(d,config)).length;
  // v3.1 day-level Top Option helpers — replace the per-slot pool/bid concept.
  const TOP_OPTION_DEFAULT_BID = 1;
  const inTopOption = (dateKey, uid) => !!(topOptions[dateKey] && uid in topOptions[dateKey]);
  const dayTopOptionerCount = dateKey => topOptions[dateKey] ? Object.keys(topOptions[dateKey]).length : 0;
  const getDayTopOptioners = dateKey => topOptions[dateKey] || {};
  const getDayBid = (dateKey, uid) => topOptions[dateKey]?.[uid]?.bid ?? 0;
  const getDaySlotPref = (dateKey, uid) => topOptions[dateKey]?.[uid]?.slotPref ?? null;

  // Post-reconcile admin insight: flag days that were hard to cover.
  //   hasAuto     — at least one slot was auto-assigned (nobody volunteered for it)
  //   challenging — ALL filled slots auto AND nobody preferred AND ≥50% of providers blocked it.
  //                 These are the dates the admin had to fight for coverage on, and are worth
  //                 spot-checking when planning the next block.
  const dayInsights = k => {
    if(me?.role!=="admin") return null;
    const day = shifts[k]||{};
    const entries = Object.values(day);
    const filled = entries.filter(e=>getUid(e));
    if(filled.length===0) return null;
    const autoFilled = filled.filter(isAuto).length;
    const hasAuto = autoFilled>0;
    const allAuto = autoFilled===filled.length;
    const provs = users.filter(u=>u.role==="provider");
    let blockedCount=0, preferredCount=0;
    for(const p of provs){
      if(isUnavail(p.id,k)) blockedCount++;
      if(isWanted(p.id,k)) preferredCount++;
    }
    const blockRate = provs.length ? blockedCount/provs.length : 0;
    const challenging = allAuto && preferredCount===0 && blockRate>=0.5;
    return { hasAuto, allAuto, challenging, blockedCount, preferredCount, totalProvs:provs.length, blockRate };
  };

  // v3.1 Top Option setter — replaces joinPool. Adds/updates the user's per-day commitment.
  // slotPref is a slot id, or null/undefined for "Either". Bid is capped at the user's totalPts.
  // Implicitly marks the day preferred (signal that they want it). Idempotent — calling again
  // updates bid/slotPref in place. Use clearTopOption to walk away.
  const setTopOption = async (dateKey, slotPref, rawBid) => {
    if(!me || me.role !== "provider") return;
    if(!isAvailabilityOpen(currentBlock)) { flash("⚠️ Availability is closed for this block"); return; }
    if(!inBlock(dateKey, config)) { flash("⚠️ Outside block"); return; }
    if(!me.seniorityId) { flash("⚠️ Seniority not assigned yet"); return; }
    if(isUnavail(me.id, dateKey)) { flash("⚠️ You marked this day unavailable"); return; }
    const cap = Math.max(0, Math.floor(totalPts(me.id)));
    const bid = Math.max(0, Math.min(cap, parseInt(rawBid)||TOP_OPTION_DEFAULT_BID));
    const sp = (slotPref==null) ? null : parseInt(slotPref);
    const wasIn = inTopOption(dateKey, me.id);
    const nextTops = {...topOptions, [dateKey]: {...(topOptions[dateKey]||{}), [me.id]: {bid, slotPref: sp}}};
    setTopOptions(nextTops); await persist("topOptions", nextTops);
    // Top Option implies preferred — auto-mark the day. (Leaving doesn't auto-unmark.)
    if(!wasIn){
      const pcur = preferences[me.id]||[];
      if(!pcur.includes(dateKey)){
        const pnext = {...preferences,[me.id]:[...pcur,dateKey]};
        setPreferences(pnext); await persist("prefs",pnext);
      }
    }
    trackEvent("topOption.set", { dateKey, slotPref: sp, bid });
    flash(wasIn ? `Top Option updated · bid ${bid}` : `🎯 Top Option set · bid ${bid} pt${bid===1?"":"s"}`);
  };

  // Walks the user away from a Top Option commitment for a day. Doesn't touch preference state.
  const clearTopOption = async (dateKey) => {
    if(!me || me.role !== "provider") return;
    if(!isAvailabilityOpen(currentBlock)) { flash("⚠️ Availability is closed for this block"); return; }
    if(!inTopOption(dateKey, me.id)) return;
    const dayMap = {...(topOptions[dateKey]||{})};
    delete dayMap[me.id];
    const nextTops = {...topOptions};
    if(Object.keys(dayMap).length) nextTops[dateKey] = dayMap;
    else delete nextTops[dateKey];
    setTopOptions(nextTops); await persist("topOptions", nextTops);
    trackEvent("topOption.clear", { dateKey });
    flash("Top Option removed");
  };

  // Update just the bid for an existing Top Option. Clamped to [0, floor(totalPts)].
  // No-op (with toast) if the user isn't currently Top-Optioning the day or if availability is closed.
  const setBid = async (dateKey, rawAmount) => {
    if(!me || me.role !== "provider") return;
    if(!isAvailabilityOpen(currentBlock)) { flash("⚠️ Availability is closed for this block"); return; }
    if(!inTopOption(dateKey, me.id)) return;
    const cap = Math.max(0, Math.floor(totalPts(me.id)));
    const bid = Math.max(0, Math.min(cap, parseInt(rawAmount)||0));
    const cur = topOptions[dateKey][me.id];
    const nextTops = {...topOptions, [dateKey]: {...topOptions[dateKey], [me.id]: {...cur, bid}}};
    setTopOptions(nextTops); await persist("topOptions", nextTops);
    trackEvent("topOption.set", { dateKey, slotPref: cur.slotPref, bid });
  };

  // Update slot preference on the user's existing Top Option for a day.
  const setSlotPref = async (dateKey, slotPref) => {
    if(!me || me.role !== "provider") return;
    if(!isAvailabilityOpen(currentBlock)) { flash("⚠️ Availability is closed for this block"); return; }
    if(!inTopOption(dateKey, me.id)) return;
    const sp = (slotPref==null) ? null : parseInt(slotPref);
    const cur = topOptions[dateKey][me.id];
    const nextTops = {...topOptions, [dateKey]: {...topOptions[dateKey], [me.id]: {...cur, slotPref: sp}}};
    setTopOptions(nextTops); await persist("topOptions", nextTops);
    trackEvent("topOption.set", { dateKey, slotPref: sp, bid: cur.bid });
  };

  // Performs the actual block toggle without the cap check.
  // Used by toggleUnavail (pre-checked) and by the confirm-modal "Continue" button.
  const _applyToggleUnavail = async k => {
    if(!me||me.role!=="provider") return;
    const cur=unavailability[me.id]||{};
    const blocked=k in cur;
    const nextCur={...cur};
    if(blocked) delete nextCur[k]; else nextCur[k]=null;
    const next={...unavailability,[me.id]:nextCur};
    setUnavailability(next); await persist("unavail",next);
    if(!blocked){
      const pcur=preferences[me.id]||[];
      if(pcur.includes(k)){ const pnext={...preferences,[me.id]:pcur.filter(d=>d!==k)}; setPreferences(pnext); await persist("prefs",pnext); }
    }
    trackEvent("unavail.toggle", { dateKey: k, blocked: !blocked });
  };

  const toggleUnavail = async k => {
    if(!me||me.role!=="provider") return;
    const cur=unavailability[me.id]||{};
    const blocked=k in cur;
    if(!blocked){
      const hasWin=Object.values(shifts[k]||{}).some(e=>getUid(e)===me.id);
      if(hasWin){flash("⚠️ You're already awarded a shift this day");return;}
      if(inTopOption(k, me.id)){flash("⚠️ Drop your Top Option for this day first");return;}
      // Cap check — blocking past the configured limit needs confirmation, or is forbidden if user is broke.
      const cap = checkBlockCapacity(me.id, k);
      if (cap.kind === "forbidden") {
        flash(`⚠️ No points left to spend — can't block past the limit (max ${config.maxBlockedDays} day${config.maxBlockedDays===1?"":"s"})`);
        return;
      }
      if (cap.kind === "over") {
        // Defer to confirm modal — actual mutation happens when the user clicks Continue.
        setConfirmBlockOver({ dateKey:k, penalty:cap.penalty, projected:cap.projected });
        return;
      }
    }
    await _applyToggleUnavail(k);
  };

  const setUnavailReason = async (k, reason) => {
    if(!me||me.role!=="provider") return;
    const cur=unavailability[me.id]||{};
    if(!(k in cur)) return;
    const next={...unavailability,[me.id]:{...cur,[k]:reason||null}};
    setUnavailability(next); await persist("unavail",next);
  };

  const togglePreference = async k => {
    if(!me||me.role!=="provider") return;
    if(isUnavail(me.id,k)){ flash("⚠️ You've blocked this day"); return; }
    if(!inBlock(k,config)){ flash("⚠️ Outside block"); return; }
    const cur=preferences[me.id]||[];
    const wanted=cur.includes(k);
    // Removing preferred while a Top Option is active is contradictory — clear the Top Option too.
    if(wanted && inTopOption(k, me.id)){
      await clearTopOption(k);
    }
    const next={...preferences,[me.id]:wanted?cur.filter(d=>d!==k):[...cur,k]};
    setPreferences(next); await persist("prefs",next);
    trackEvent("preference.toggle", { dateKey: k, wanted: !wanted });
  };

  const setTargets = async (uid, targets) => await updateUser(uid, { targets });

  /* ── Auto-assign ── */
  /* ── Auto-assign ──
     Per the spec rules, runs in TWO ordered passes after pools are reconciled:
       Pass 1 — fill any open slot whose date is PREFERRED by some eligible provider.
       Pass 2 — fill any remaining open slot from providers who are AVAILABLE (not blocked, not
                preferred either — non-preferred picks up the involuntary + non-preferred bonuses).
     Both passes respect the hard MAX cap: at-max providers are filtered out entirely (they don't
     just rank last — they're ineligible). Within each pass, slots iterate by date.
     Each new award is tagged `source: "preferred-auto" | "available-auto"`. */
  // `startingShifts` lets the caller pass a not-yet-persisted shifts object (e.g. the post-reconcile
  // result) so we can compute auto-assignment on top of it without waiting for state to update.
  const computeAutoAssign = (startingShifts) => {
    const result=JSON.parse(JSON.stringify(startingShifts || shifts));
    const provs=users.filter(u=>u.role==="provider"&&u.seniorityId);
    const liveCount={}, liveDates={};
    provs.forEach(p=>{liveCount[p.id]=0; liveDates[p.id]=new Set();});
    Object.entries(result).forEach(([k,day])=>Object.values(day).forEach(e=>{
      const uid=getUid(e);
      if(liveCount[uid]!==undefined){ liveCount[uid]++; liveDates[uid].add(k); }
    }));
    const MS_DAY = 86400000;
    const isAtMax = p => { const m=p.targets?.max||0; return m>0 && liveCount[p.id]>=m; };
    const spacingScore = (p, dateKey) => {
      const pref = p.spacingPref;
      if(!pref || pref.mode==="none" || !liveDates[p.id] || liveDates[p.id].size===0) return 0;
      const target = parseDk(dateKey).getTime();
      const existing = [...liveDates[p.id]].map(k=>parseDk(k).getTime());
      if(pref.mode==="spread"){
        let minGap = Infinity;
        for(const t of existing){
          const g = Math.abs(Math.round((t-target)/MS_DAY));
          if(g<minGap) minGap = g;
        }
        const desired = pref.minGap || 2;
        return minGap < desired ? (desired - minGap) * 5 : 0;
      }
      if(pref.mode==="consecutive"){
        const all = [...existing, target].sort((a,b)=>a-b);
        const idx = all.indexOf(target);
        let runLen = 1;
        for(let i=idx-1; i>=0; i--){ if(Math.round((all[i+1]-all[i])/MS_DAY)===1) runLen++; else break; }
        for(let i=idx+1; i<all.length; i++){ if(Math.round((all[i]-all[i-1])/MS_DAY)===1) runLen++; else break; }
        const cap = pref.maxConsecutive || 3;
        if(runLen > cap) return (runLen - cap) * 10;
        if(runLen > 1) return -1;
        return 0;
      }
      return 0;
    };
    // Common per-pass ranking. `wantedFilter` decides which providers are eligible at all
    // for this pass (preferred-only in pass 1, non-preferred in pass 2).
    const rankFor = (dateKey, wantedFilter) => {
      const elig = provs.filter(p => {
        if(isAtMax(p)) return false;                                      // hard max cap
        if(isUnavail(p.id, dateKey)) return false;                        // not on blocked days
        if(Object.values(result[dateKey]||{}).some(e=>getUid(e)===p.id)) return false; // already on this day
        return wantedFilter(p, dateKey);
      });
      elig.sort((a,b)=>{
        // 1) Everyone must clear their admin-set minimum first.
        const aMin=config.seniorityLevels.find(l=>l.id===a.seniorityId)?.minShifts||0;
        const bMin=config.seniorityLevels.find(l=>l.id===b.seniorityId)?.minShifts||0;
        const aB=Math.max(0,aMin-liveCount[a.id]), bB=Math.max(0,bMin-liveCount[b.id]);
        if(aB!==bB) return bB-aB;
        // 2) Back-to-back spacing fit.
        const aS=spacingScore(a,dateKey), bS=spacingScore(b,dateKey);
        if(aS!==bS) return aS-bS;
        // 3) Below-ideal first.
        const aId=a.targets?.ideal||0, bId=b.targets?.ideal||0;
        const aBi=aId>0&&liveCount[a.id]<aId, bBi=bId>0&&liveCount[b.id]<bId;
        if(aBi!==bBi) return aBi?-1:1;
        // 4) Fairness fallback.
        if(liveCount[a.id]!==liveCount[b.id]) return liveCount[a.id]-liveCount[b.id];
        return totalPts(a.id)-totalPts(b.id);
      });
      return elig;
    };
    const newA=[], unfilled=[];
    const tryFill = (source, wantedFilter) => {
      for(const dateKey of blockDays){
        for(const slot of config.shiftSlots){
          if(getUid(result[dateKey]?.[slot.id])) continue;
          const elig = rankFor(dateKey, wantedFilter);
          if(!elig.length) continue;  // skip — pass 2 (or unfilled) will catch it
          const winner = elig[0];
          if(!result[dateKey]) result[dateKey]={};
          const prev = result[dateKey][slot.id];
          result[dateKey][slot.id] = {...(prev||{}), uid:winner.id, auto:true, source};
          liveCount[winner.id]++;
          liveDates[winner.id].add(dateKey);
          newA.push({dateKey,slot,user:winner,source});
        }
      }
    };
    // Pass 1: preferred-day fills only.
    tryFill("preferred-auto", (p, dk) => isWanted(p.id, dk));
    // Pass 2: available (non-preferred, non-blocked) fills. Preferred is excluded so we don't
    // re-evaluate them here (they had their shot in pass 1; if they didn't take it, they're at max).
    tryFill("available-auto", (p, dk) => !isWanted(p.id, dk));
    // After both passes, log any slot that still has no winner so the admin can see it.
    for(const dateKey of blockDays){
      for(const slot of config.shiftSlots){
        if(!getUid(result[dateKey]?.[slot.id])) unfilled.push({dateKey, slot});
      }
    }
    return {result,newAssignments:newA,unfilled};
  };

  const applyAutoAssign = async () => {
    if(!autoPreview) return;
    setShifts(autoPreview.result); await persist("shifts",autoPreview.result);
    flash(`✅ ${autoPreview.newAssignments.length} shifts auto-assigned`);
    setAutoPreview(null);
  };

  /* ── Reconciliation (pool → winners) ──
     Per the spec rules:
       1. Process the most-contested pools first (size desc, then date asc for determinism). This
          prevents an early small-pool win from locking a user out of a more-contested later one.
       2. Hard max cap: a user already at their max is filtered OUT of every remaining pool —
          they never win, never pay (refund). If a winner would exceed max, we skip them and
          pick the next-ranked bidder.
       3. Tiebreak base = pointsAtClose snapshot (entering-block points), not live totalPts —
          shifts awarded during this reconcile don't credit pts until block lock, so ranking
          uses the snapshot minus any bids already spent in this same reconcile.
       4. Each award is tagged with `source: "pool" | "cascade"` so the post-block report can
          attribute correctly. */
  // v3.1 reconcile — day-major loop over topOptions instead of slot-major over per-slot pools.
  // For each day with Top-Optioners: sort by (bid desc, snapshot pts desc, uid asc). Place each
  // in their preferred slot if open, else cascade to the other open slot. Skip if at-max.
  // Hard max cap is enforced (not just rank-deprioritized).
  const computeReconcile = () => {
    const result = JSON.parse(JSON.stringify(shifts));
    const awarded = [];
    const deltas = {};
    const baseCache = {};
    const effPts = uid => {
      if(baseCache[uid]===undefined) baseCache[uid] = snapshotPtsForReconcile(uid);
      return baseCache[uid] + (deltas[uid]||0);
    };
    // Per-user awarded-shift counter. Seeded with any pre-existing awarded entries (admin override
    // or earlier reconcile) so we don't double-count or push past max.
    const perUserShifts = {};
    Object.values(result).forEach(day=>Object.values(day).forEach(e=>{const u=getUid(e); if(u) perUserShifts[u]=(perUserShifts[u]||0)+1;}));
    const maxOf = uid => {
      const u = users.find(x=>x.id===uid);
      return u?.targets?.max || 0;  // 0 = unset = no cap
    };
    const isAtMax = uid => { const m=maxOf(uid); return m>0 && (perUserShifts[uid]||0) >= m; };

    // Build day queue: each day that has Top-Optioners and at least one open slot.
    // Cleaning: drop Top-Optioners who are now blocked or already won another slot that day.
    // Each item carries headlineBid = max bid among its candidates, used for ordering.
    const queue = [];
    for(const dateKey of blockDays){
      const dayTops = topOptions[dateKey];
      if(!dayTops || !Object.keys(dayTops).length) continue;
      const day = result[dateKey] || {};
      const cleaned = Object.entries(dayTops)
        .map(([uidStr, info]) => ({uid: parseInt(uidStr), bid: info.bid|0, slotPref: info.slotPref ?? null}))
        .filter(c =>
          !isUnavail(c.uid, dateKey) &&
          !Object.values(day).some(e => getUid(e) === c.uid)  // not already awarded a slot today
        );
      if(!cleaned.length) continue;
      const openSlots = config.shiftSlots.filter(s => !getUid(day[s.id]));
      if(!openSlots.length) continue;
      const headlineBid = cleaned.reduce((m, c) => Math.max(m, c.bid), 0);
      queue.push({dateKey, cleaned, openSlotsCount: openSlots.length, headlineBid});
    }
    // Process highest-bid days FIRST. The user's strongest bid signals their highest-priority
    // commitment, so we let them win that day before the at-max cap closes them out of others.
    // Ties broken by contested-count desc (more candidates = more fairness pressure), then date asc.
    queue.sort((a,b) =>
      (b.headlineBid - a.headlineBid) ||
      (b.cleaned.length - a.cleaned.length) ||
      a.dateKey.localeCompare(b.dateKey)
    );

    for(const item of queue){
      const { dateKey } = item;
      const day = result[dateKey] = result[dateKey] || {};
      // Re-evaluate open slots inside the loop in case admin pre-awarded changed things mid-day.
      const openSlots = config.shiftSlots.filter(s => !getUid(day[s.id]));
      if(!openSlots.length) continue;
      // Filter at-max + already-on-day, then sort by (bid desc, effPts desc, uid asc).
      const candidates = item.cleaned.filter(c =>
        !isAtMax(c.uid) &&
        !Object.values(day).some(e => getUid(e) === c.uid)
      ).sort((a,b) => {
        if(a.bid !== b.bid) return b.bid - a.bid;
        const ap = effPts(a.uid), bp = effPts(b.uid);
        if(ap !== bp) return bp - ap;
        return a.uid - b.uid;
      });
      if(!candidates.length) continue;
      const contested = item.cleaned.length > 1;
      // Vickrey-style pricing: the top bidder pays one more than the *second-highest* bid (capped
      // by their own bid and remaining points). Solo bidders pay 1 (the floor — there's no
      // second-highest to outbid). This means a 7-pt bid against a 2-pt bid costs the winner 3 pts,
      // not 7 — they pay just enough to outbid the runner-up. Encourages honest bidding without
      // overspending.
      const secondHighestBid = candidates[1]?.bid ?? 0;
      let openLeft = [...openSlots];
      let firstWinner = true;  // only the top bidder pays; cascaded losers (later iterations) pay 0
      const allUids = item.cleaned.map(c => c.uid);
      for(const c of candidates){
        if(!openLeft.length) break;
        if(isAtMax(c.uid)) continue;
        // Place in preferred slot if open, else first open slot (lenient cascade).
        let target = openLeft.find(s => s.id === c.slotPref);
        const cascadedSlot = !target;
        if(!target) target = openLeft[0];
        const source = cascadedSlot ? "cascade" : (contested ? "pool" : "pool-solo");
        // Vickrey charge applies only to the highest-bid winner. Subsequent winners (filling other
        // open slots cascade-style) pay 0 — they didn't outbid anyone.
        let charge = 0;
        if(firstWinner){
          charge = Math.max(0, Math.min(secondHighestBid + 1, c.bid, Math.floor(effPts(c.uid))));
        }
        day[target.id] = {
          uid: c.uid, auto: false, source,
          ...(charge > 0 ? { bid: charge } : {}),
        };
        if(charge > 0) deltas[c.uid] = (deltas[c.uid]||0) - charge;
        perUserShifts[c.uid] = (perUserShifts[c.uid]||0) + 1;
        awarded.push({
          dateKey, slot: target, winner: c.uid,
          contested, cascaded: cascadedSlot && !firstWinner,
          pool: allUids, bid: charge, source,
        });
        openLeft = openLeft.filter(s => s !== target);
        firstWinner = false;
      }
    }
    // Sweep: any day that ended up with no entries gets pruned.
    for(const dateKey of Object.keys(result)){
      if(!Object.keys(result[dateKey]).length) delete result[dateKey];
    }
    return { result, awarded, deltas };
  };

  // v3 "Close & assign" — runs reconcile + two-pass auto-assign as one atomic transition.
  // Pool resolution comes from the preview; auto-assign is computed fresh against the post-reconcile
  // shifts so it can fill any newly-revealed open slots. Phase lands in Reconciliation when done.
  const applyReconcile = async () => {
    if(!reconcilePreview) return;
    const { result: reconResult, awarded, deltas } = reconcilePreview;
    // Chain auto-assign on top of the reconcile result.
    const auto = computeAutoAssign(reconResult);
    const finalShifts = auto.result;
    const autoCount = auto.newAssignments.length;
    setShifts(finalShifts); await persist("shifts",finalShifts);
    // Top Options have served their purpose — clear them so the next round (after a reset) starts clean.
    if(Object.keys(topOptions).length){ setTopOptions({}); await persist("topOptions", {}); }
    // Snapshot pointsAtClose for every provider BEFORE deducting bid spend, so future re-reconciles
    // (e.g. after admin reset+reclose) tiebreak against the same entering-block balance.
    const pointsAtClose = {};
    users.forEach(u => { if(u.role==="provider") pointsAtClose[u.id] = u.points || 0; });
    // Collect open-shift incentive credits for any newly-awarded slots.
    const { credits: incCredits, nextOpenIncentives, mutated: incMutated } = collectIncentiveCredits(finalShifts);
    if(Object.keys(deltas).length || Object.keys(incCredits).length){
      const nu = users.map(u => {
        const bidDelta = deltas[u.id] || 0;
        const incBonus = incCredits[u.id] || 0;
        if(bidDelta === 0 && incBonus === 0) return u;
        return {...u, points: Math.max(0, (u.points||0) + bidDelta + incBonus)};
      });
      setUsers(nu); await persist("users",nu);
    }
    if(incMutated){ setOpenIncentives(nextOpenIncentives); await persist("openIncentives", nextOpenIncentives); }
    // Stash the deltas on the current block so "Reset block" can reverse them.
    // Phase advances to RECON — providers can no longer change availability/topOptions but can confirm/flag.
    await updateCurrentBlock({phase: PHASE.RECON, lastReconcileDeltas:deltas, pointsAtClose});
    trackEvent("block.reconcile", {
      blockId: currentBlock?.id != null ? String(currentBlock.id) : null,
      awards: awarded,
      autoCount,
      deltas,
    });
    flash(`✅ ${awarded.length} Top Option ${awarded.length===1?"award":"awards"} · ${autoCount} auto-filled · block now in Reconciliation`);
    setReconcilePreview(null);
    // Optional convenience: surface the block report immediately so admin can audit.
    setShowBlockReport(true);
  };

  const resetBlock = async () => {
    // Clear all shifts within the current block, send phase back to availability, and
    // reverse the last reconcile's tie-break point penalties.
    const nextShifts = {...shifts};
    let cleared = 0;
    for(const k of blockDays){ if(nextShifts[k]){ cleared += Object.keys(nextShifts[k]).length; delete nextShifts[k]; } }
    setShifts(nextShifts); await persist("shifts",nextShifts);
    const restored = currentBlock?.lastReconcileDeltas || {};
    if(Object.keys(restored).length){
      const nu = users.map(u=>restored[u.id]?{...u,points:Math.max(0,(u.points||0)-restored[u.id])}:u);
      setUsers(nu); await persist("users",nu);
    }
    // Reverting to availability invalidates the entering-pts snapshot — a fresh snapshot is taken
    // when assignment runs again. Also clears the phase back to AVAIL so providers can edit.
    await updateCurrentBlock({phase: PHASE.AVAIL, lastReconcileDeltas:{}, pointsAtClose:null});
    setConfirmReset(false);
    flash(`↺ Block reset · ${cleared} slot${cleared===1?"":"s"} cleared · back to Availability`);
  };

  /* ── Reconciliation: confirm / flag / auto-swap / marketplace ── */

  // Per-shift confirmation by the awarded provider. "ok" = looks good, "flagged" = problem.
  // We store on the entry itself so it travels with the slot through any takes/swaps.
  const setShiftConfirm = async (dateKey, slotId, value /* "ok" | null */) => {
    const entry = shifts[dateKey]?.[slotId];
    if(!entry || getUid(entry) !== me.id) return;
    const next = {...shifts};
    next[dateKey] = {...next[dateKey], [slotId]: {...entry, confirm: value, flagReason: value==="ok"?null:entry.flagReason}};
    setShifts(next); await persist("shifts", next);
    if(value === "ok") trackEvent("shift.confirm", { dateKey, slotId });
  };

  // Returns ALL eligible swap candidates for a flagged shift, ranked by:
  //   1. preferred-date status (preferred > available > non-preferred non-available)
  //   2. snapshot points (entering balance)
  //   3. lowest uid for determinism
  // Eligibility: provider with seniority, not blocked, below max, not already on this day, not the
  // current assignee. Used by the admin Flagged-shifts panel for one-click reassignment.
  const findSwapCandidates = (dateKey, originalUid) => {
    const liveCount = {};
    users.forEach(u => { if(u.role==="provider") liveCount[u.id] = 0; });
    Object.values(shifts).forEach(day => Object.values(day).forEach(e => {
      const uid = getUid(e);
      if(uid != null && liveCount[uid] !== undefined) liveCount[uid]++;
    }));
    const candidates = users.filter(u => {
      if(u.role !== "provider" || !u.seniorityId) return false;
      if(u.id === originalUid) return false;
      if(isUnavail(u.id, dateKey)) return false;
      const max = u.targets?.max || 0;
      if(max > 0 && liveCount[u.id] >= max) return false;
      if(Object.values(shifts[dateKey]||{}).some(e => getUid(e) === u.id)) return false;
      return true;
    }).map(u => ({
      user: u,
      preferred: isWanted(u.id, dateKey),
      currentCount: liveCount[u.id] || 0,
      snapshotPts: snapshotPtsForReconcile(u.id),
    }));
    candidates.sort((a,b) => {
      // Preferred providers ranked above non-preferred.
      if(a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      // Then highest snapshot points wins.
      if(a.snapshotPts !== b.snapshotPts) return b.snapshotPts - a.snapshotPts;
      return a.user.id - b.user.id;
    });
    return candidates;
  };

  // Admin reassigns a flagged shift to a candidate. Lifts the flag, stamps source "admin-swap",
  // tracks who it came from. New assignee gets a fresh confirm prompt.
  const acceptSwapCandidate = async (dateKey, slotId, candidateUid) => {
    if(!me || me.role !== "admin") { flash("⚠️ Admin only"); return; }
    const entry = shifts[dateKey]?.[slotId];
    if(!entry || !getUid(entry)) return;
    const originalUid = getUid(entry);
    if(originalUid === candidateUid) { flash("⚠️ Same provider"); return; }
    const ns = {...shifts};
    ns[dateKey] = {...ns[dateKey], [slotId]: {
      ...entry,
      uid: candidateUid,
      source: "auto-swap",
      swappedFrom: originalUid,
      confirm: null,
      flagReason: null,
    }};
    setShifts(ns); await persist("shifts", ns);
    // Close any auto-posted marketplace listing for this slot — the swap settled the issue.
    const nm = marketplace.map(l =>
      (l.dateKey === dateKey && l.slotId === slotId && l.status === "open" && l.autoPosted)
        ? {...l, status:"cancelled", tradeOffers:(l.tradeOffers||[]).map(o => o.status==="pending" ? {...o, status:"stale"} : o)}
        : l
    );
    if(nm.some((l,i) => l !== marketplace[i])){ setMarketplace(nm); await persist("marketplace", nm); }
    const newUser = users.find(u => u.id === candidateUid);
    flash(`✅ Reassigned to ${newUser?.name?.split(" ")[0] || "provider"}`);
  };

  // Admin clears a flag without swapping (e.g. provider talked to them out of band).
  const clearFlag = async (dateKey, slotId) => {
    if(!me || me.role !== "admin") return;
    const entry = shifts[dateKey]?.[slotId];
    if(!entry) return;
    const ns = {...shifts};
    ns[dateKey] = {...ns[dateKey], [slotId]: {...entry, confirm: null, flagReason: null}};
    setShifts(ns); await persist("shifts", ns);
    flash("Flag cleared");
  };

  // Provider flags an awarded shift. v3.2: silent auto-swap removed — every flag goes to admin
  // for review. Shift is marked flagged and auto-posted to the marketplace at zero incentive so
  // self-service trade is also possible. Admin sees a recommendations panel on the dashboard.
  const flagShift = async (dateKey, slotId, reason) => {
    const entry = shifts[dateKey]?.[slotId];
    if(!entry || getUid(entry) !== me.id) return;
    const next = {...shifts};
    next[dateKey] = {...next[dateKey], [slotId]: {...entry, confirm: "flagged", flagReason: reason || null}};
    setShifts(next); await persist("shifts", next);
    await _postListing(dateKey, slotId, 0, { autoPosted: true, flagReason: reason || null });
    trackEvent("shift.flag", { dateKey, slotId, reason: reason || null });
    flash("⚠️ Flagged · admin notified, also posted to marketplace");
    setFlagDraft(null);
  };

  // Internal listing creator (no eligibility checks beyond ownership). Used by flag auto-post
  // and by the user's explicit "post for take" action.
  const _postListing = async (dateKey, slotId, incentivePts, opts = {}) => {
    const entry = shifts[dateKey]?.[slotId];
    if(!entry) return null;
    const sellerId = getUid(entry);
    if(!sellerId) return null;
    // Don't double-list — if there's already an open listing for this slot, just no-op.
    const existing = marketplace.find(l => l.dateKey === dateKey && l.slotId === slotId && l.status === "open");
    if(existing) return existing;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const listing = {
      id, dateKey, slotId, sellerId,
      incentivePts: Math.max(0, parseInt(incentivePts)||0),
      postedAt: Date.now(),
      status: "open",
      autoPosted: !!opts.autoPosted,
      flagReason: opts.flagReason || null,
    };
    const next = [...marketplace, listing];
    setMarketplace(next); await persist("marketplace", next);
    return listing;
  };

  // Provider posts their own awarded shift for take, with optional incentive points.
  const postForTake = async (dateKey, slotId, incentivePts) => {
    if(!me || me.role !== "provider") return;
    const entry = shifts[dateKey]?.[slotId];
    if(!entry || getUid(entry) !== me.id) { flash("⚠️ You don't own this shift"); return; }
    const cap = Math.max(0, Math.floor(me.points || 0));
    const inc = Math.max(0, Math.min(cap, parseInt(incentivePts)||0));
    const listing = await _postListing(dateKey, slotId, inc, {});
    if(listing) {
      trackEvent("marketplace.post", { dateKey, slotId, incentivePts: inc, listingId: listing.id });
      flash(`📣 Listed${inc>0?` · ${inc} pt incentive`:""}`);
    }
    setListDraft(null);
  };

  // Anyone eligible can claim an open listing. Reassigns the shift, transfers incentive points.
  const takeListing = async (listingId) => {
    const listing = marketplace.find(l => l.id === listingId);
    if(!listing || listing.status !== "open") return;
    if(listing.sellerId === me.id) { flash("⚠️ Can't take your own listing"); return; }
    if(me.role !== "provider") { flash("⚠️ Only providers can take shifts"); return; }
    if(!me.seniorityId) { flash("⚠️ Seniority not assigned"); return; }
    if(isUnavail(me.id, listing.dateKey)) { flash("⚠️ You blocked this day"); return; }
    // Already on this day? (Each provider gets at most one slot per date.)
    if(Object.values(shifts[listing.dateKey]||{}).some(e => getUid(e) === me.id)) {
      flash("⚠️ You already have a shift this day"); return;
    }
    // Max-shift cap.
    let myCount = 0;
    Object.values(shifts).forEach(day => Object.values(day).forEach(e => { if(getUid(e) === me.id) myCount++; }));
    const myMax = me.targets?.max || 0;
    if(myMax > 0 && myCount >= myMax) { flash(`⚠️ Would exceed your max (${myMax})`); return; }
    // Verify the shift is still owned by the seller.
    const entry = shifts[listing.dateKey]?.[listing.slotId];
    if(!entry || getUid(entry) !== listing.sellerId) {
      flash("⚠️ Listing is stale — refresh"); return;
    }
    // Reassign the shift.
    const ns = {...shifts};
    ns[listing.dateKey] = {...ns[listing.dateKey], [listing.slotId]: {
      ...entry, uid: me.id, source: "marketplace", takenFrom: listing.sellerId, confirm: null,
    }};
    setShifts(ns); await persist("shifts", ns);
    // Move incentive points from seller → taker (only when > 0).
    if(listing.incentivePts > 0){
      const nu = users.map(u => {
        if(u.id === listing.sellerId) return {...u, points: Math.max(0, (u.points||0) - listing.incentivePts)};
        if(u.id === me.id) return {...u, points: (u.points||0) + listing.incentivePts};
        return u;
      });
      setUsers(nu); await persist("users", nu);
    }
    // Mark listing taken; any pending trade offers become stale (the shift is no longer up).
    const nm = marketplace.map(l => l.id === listingId ? {
      ...l,
      status: "taken",
      takenBy: me.id,
      takenAt: Date.now(),
      tradeOffers: (l.tradeOffers||[]).map(o => o.status==="pending" ? {...o, status:"stale"} : o),
    } : l);
    setMarketplace(nm); await persist("marketplace", nm);
    trackEvent("marketplace.take", {
      dateKey: listing.dateKey,
      slotId: listing.slotId,
      listingId,
      incentivePts: listing.incentivePts,
    });
    flash(`✅ Shift taken${listing.incentivePts>0?` · +${listing.incentivePts} pt${listing.incentivePts===1?"":"s"}`:""}`);
  };

  // Seller (or admin) cancels an open listing. Doesn't unassign the shift.
  // Any pending trade offers on it become "stale".
  const cancelListing = async (listingId) => {
    const listing = marketplace.find(l => l.id === listingId);
    if(!listing || listing.status !== "open") return;
    if(listing.sellerId !== me.id && me.role !== "admin") { flash("⚠️ Not your listing"); return; }
    const nm = marketplace.map(l => l.id === listingId ? {
      ...l,
      status: "cancelled",
      tradeOffers: (l.tradeOffers||[]).map(o => o.status==="pending" ? {...o, status:"stale"} : o),
    } : l);
    setMarketplace(nm); await persist("marketplace", nm);
    trackEvent("marketplace.cancel", { listingId });
    flash("Listing cancelled");
  };

  /* ── Two-sided trades ── */

  // Eligibility check for a swap: can `taker` validly hold `seller`'s shift, AND can `seller`
  // validly hold `taker`'s shift? Used by both Take (one-sided, second half is null) and Offer trade.
  // Returns { ok: true } or { ok: false, why: string }.
  const canHoldShift = (uid, dateKey, ignoreSlotId, ignoreDateKey) => {
    const u = users.find(x => x.id === uid);
    if(!u || u.role !== "provider") return { ok:false, why:"Not a provider" };
    if(!u.seniorityId) return { ok:false, why:"No seniority assigned" };
    if(isUnavail(uid, dateKey)) return { ok:false, why:"Blocked that day" };
    // Already on this day in another slot? (Skipping the slot they may be vacating.)
    const dayS = shifts[dateKey] || {};
    const conflict = Object.entries(dayS).some(([sidStr, e]) => {
      const sid = parseInt(sidStr);
      if(dateKey === ignoreDateKey && sid === ignoreSlotId) return false;
      return getUid(e) === uid;
    });
    if(conflict) return { ok:false, why:"Already on that day" };
    return { ok:true };
  };

  // Provider B offers to swap one of their awarded shifts in exchange for the listing.
  // Optional incentive points B will give A on accept (a sweetener).
  const offerTrade = async (listingId, offererDateKey, offererSlotId, incentivePts) => {
    if(!me || me.role !== "provider") return;
    const listing = marketplace.find(l => l.id === listingId);
    if(!listing || listing.status !== "open") { flash("⚠️ Listing closed"); return; }
    if(listing.sellerId === me.id) { flash("⚠️ Can't offer trade on your own listing"); return; }
    // Verify B owns the offered shift.
    const myEntry = shifts[offererDateKey]?.[offererSlotId];
    if(!myEntry || getUid(myEntry) !== me.id) { flash("⚠️ You don't own that shift"); return; }
    // Pre-validate the swap (both sides must be valid holders).
    const sellerCanHoldB = canHoldShift(listing.sellerId, offererDateKey, offererSlotId, offererDateKey);
    if(!sellerCanHoldB.ok) { flash(`⚠️ Seller can't take your shift: ${sellerCanHoldB.why}`); return; }
    const meCanHoldA = canHoldShift(me.id, listing.dateKey, listing.slotId, listing.dateKey);
    if(!meCanHoldA.ok) { flash(`⚠️ You can't take their shift: ${meCanHoldA.why}`); return; }
    // Don't double-offer the same shift on the same listing.
    if((listing.tradeOffers||[]).some(o => o.status==="pending" && o.offererId===me.id && o.offererDateKey===offererDateKey && o.offererSlotId===offererSlotId)){
      flash("⚠️ You already offered that shift"); return;
    }
    const cap = Math.max(0, Math.floor(me.points || 0));
    const inc = Math.max(0, Math.min(cap, parseInt(incentivePts)||0));
    const offer = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      offererId: me.id,
      offererDateKey, offererSlotId,
      incentivePts: inc,
      postedAt: Date.now(),
      status: "pending",
    };
    const nm = marketplace.map(l => l.id === listingId
      ? { ...l, tradeOffers: [...(l.tradeOffers||[]), offer] }
      : l);
    setMarketplace(nm); await persist("marketplace", nm);
    flash(`🔁 Trade offer sent${inc>0?` · +${inc} pt sweetener`:""}`);
    setTradeDraft(null);
  };

  // Listing owner accepts a pending trade offer. Atomic shift swap + bidirectional point transfer.
  const acceptTradeOffer = async (listingId, offerId) => {
    if(!me || me.role !== "provider") return;
    const listing = marketplace.find(l => l.id === listingId);
    if(!listing || listing.status !== "open") { flash("⚠️ Listing closed"); return; }
    if(listing.sellerId !== me.id) { flash("⚠️ Only the lister can accept"); return; }
    const offer = (listing.tradeOffers||[]).find(o => o.id === offerId);
    if(!offer || offer.status !== "pending") { flash("⚠️ Offer no longer pending"); return; }
    // Re-verify both shifts still owned correctly.
    const aEntry = shifts[listing.dateKey]?.[listing.slotId];
    const bEntry = shifts[offer.offererDateKey]?.[offer.offererSlotId];
    if(!aEntry || getUid(aEntry) !== listing.sellerId) { flash("⚠️ Your shift moved — listing stale"); return; }
    if(!bEntry || getUid(bEntry) !== offer.offererId) { flash("⚠️ Their shift moved — offer stale"); return; }
    // Re-check eligibility (state may have changed since offer was made).
    const sellerOk = canHoldShift(listing.sellerId, offer.offererDateKey, offer.offererSlotId, listing.dateKey);
    if(!sellerOk.ok) { flash(`⚠️ Can't accept: ${sellerOk.why}`); return; }
    const offererOk = canHoldShift(offer.offererId, listing.dateKey, listing.slotId, offer.offererDateKey);
    if(!offererOk.ok) { flash(`⚠️ Can't accept: ${offererOk.why} (offerer)`); return; }
    // Swap atomically. Each shift's uid flips; source becomes "trade"; confirm resets.
    const ns = {...shifts};
    ns[listing.dateKey] = {...ns[listing.dateKey], [listing.slotId]: {
      ...aEntry, uid: offer.offererId, source: "trade", swappedFrom: listing.sellerId, confirm: null, flagReason: null,
    }};
    if(!ns[offer.offererDateKey]) ns[offer.offererDateKey] = {};
    ns[offer.offererDateKey] = {...ns[offer.offererDateKey], [offer.offererSlotId]: {
      ...bEntry, uid: listing.sellerId, source: "trade", swappedFrom: offer.offererId, confirm: null, flagReason: null,
    }};
    setShifts(ns); await persist("shifts", ns);
    // Bidirectional incentive point transfer:
    //   listing.incentivePts (A's sweetener)  → offerer (B)
    //   offer.incentivePts   (B's sweetener)  → seller  (A)
    const aDelta = (offer.incentivePts||0) - (listing.incentivePts||0);
    const bDelta = (listing.incentivePts||0) - (offer.incentivePts||0);
    if(aDelta !== 0 || bDelta !== 0){
      const nu = users.map(u => {
        if(u.id === listing.sellerId) return {...u, points: Math.max(0, (u.points||0) + aDelta)};
        if(u.id === offer.offererId) return {...u, points: Math.max(0, (u.points||0) + bDelta)};
        return u;
      });
      setUsers(nu); await persist("users", nu);
    }
    // Mark listing traded; auto-decline any other pending offers on it.
    const nm = marketplace.map(l => l.id === listingId
      ? {
          ...l,
          status: "traded",
          takenBy: offer.offererId,
          takenAt: Date.now(),
          tradeOffers: (l.tradeOffers||[]).map(o =>
            o.id === offerId ? {...o, status:"accepted"} : (o.status==="pending" ? {...o, status:"declined"} : o)
          ),
        }
      : l);
    setMarketplace(nm); await persist("marketplace", nm);
    flash(`🔁 Trade complete${listing.incentivePts||offer.incentivePts?` · pts settled`:""}`);
  };

  // Listing owner declines a single offer. Other pending offers stay alive.
  // Offerer can also withdraw their own offer (same code path; admin too).
  const declineTradeOffer = async (listingId, offerId) => {
    if(!me) return;
    const listing = marketplace.find(l => l.id === listingId);
    if(!listing) return;
    const offer = (listing.tradeOffers||[]).find(o => o.id === offerId);
    if(!offer || offer.status !== "pending") return;
    const allowed = (listing.sellerId === me.id) || (offer.offererId === me.id) || (me.role === "admin");
    if(!allowed) return;
    const newStatus = offer.offererId === me.id ? "withdrawn" : "declined";
    const nm = marketplace.map(l => l.id === listingId
      ? { ...l, tradeOffers: l.tradeOffers.map(o => o.id === offerId ? {...o, status:newStatus} : o) }
      : l);
    setMarketplace(nm); await persist("marketplace", nm);
    flash(newStatus === "withdrawn" ? "Offer withdrawn" : "Offer declined");
  };

  /* ── Admin: incentive points on open shifts ── */

  // Admin sets a bonus-points incentive on an open slot. The pts are minted by the system on award
  // (no debit anywhere). Stored in openIncentives until the slot fills, then credited to the awardee.
  const setOpenIncentive = async (dateKey, slotId, ptsRaw) => {
    if(!me || me.role !== "admin") { flash("⚠️ Admin only"); return; }
    const entry = shifts[dateKey]?.[slotId];
    if(entry && getUid(entry)) { flash("⚠️ Slot already assigned — set incentive on the marketplace listing instead"); return; }
    const pts = Math.max(0, parseInt(ptsRaw)||0);
    const next = {...openIncentives};
    if(pts > 0){
      if(!next[dateKey]) next[dateKey] = {};
      else next[dateKey] = {...next[dateKey]};
      next[dateKey][slotId] = pts;
    } else if(next[dateKey]?.[slotId] != null){
      next[dateKey] = {...next[dateKey]};
      delete next[dateKey][slotId];
      if(!Object.keys(next[dateKey]).length) delete next[dateKey];
    } else {
      return;  // no change
    }
    setOpenIncentives(next); await persist("openIncentives", next);
    flash(pts > 0 ? `Incentive set: +${pts} pt${pts===1?"":"s"}` : "Incentive removed");
  };

  // Pure helper: returns { credits: {uid: pts}, nextOpenIncentives } for any newly-awarded slots
  // in `nextShifts` that had an open incentive. Called from applyReconcile and adminAssign.
  const collectIncentiveCredits = (nextShifts) => {
    const credits = {};
    let nextOI = openIncentives;
    let mutated = false;
    for(const [k, day] of Object.entries(nextShifts || {})){
      for(const [sidStr, e] of Object.entries(day || {})){
        const uid = getUid(e);
        if(!uid) continue;
        const sid = parseInt(sidStr);
        const pts = openIncentives[k]?.[sid];
        if(pts && pts > 0){
          credits[uid] = (credits[uid] || 0) + pts;
          if(!mutated){ nextOI = {...openIncentives}; mutated = true; }
          nextOI[k] = {...nextOI[k]};
          delete nextOI[k][sid];
          if(!Object.keys(nextOI[k]).length) delete nextOI[k];
        }
      }
    }
    return { credits, nextOpenIncentives: nextOI, mutated };
  };

  /* ── Admin helpers ── */
  const updateConfig = async patch => { const next={...config,...patch}; setConfig(next); await persist("config",next); };
  // Patch the currently-active block in-place. No-op if no block is active.
  const updateCurrentBlock = async patch => {
    if(!config.currentBlockId || !Array.isArray(config.blocks)) return;
    const blocks = config.blocks.map(b => b.id===config.currentBlockId ? {...b, ...patch} : b);
    await updateConfig({blocks});
  };
  // v3.1 admin-assign: entries are now award-only (no per-slot pool field). Setting uid:null
  // simply removes the entry. Setting a uid stamps an admin-source award.
  const adminAssign = async (dk,sid,uid) => {
    const next={...shifts}; if(!next[dk]) next[dk]={};
    const wasOpen = !getUid(next[dk][sid]);
    if(uid===null){
      delete next[dk][sid];
    } else {
      next[dk][sid] = { uid, auto:false, source:"admin" };
    }
    if(!Object.keys(next[dk]).length) delete next[dk];
    setShifts(next); await persist("shifts",next);
    // If admin filled a previously-open slot that had an incentive, credit the awardee.
    let incPts = 0;
    if(uid !== null && wasOpen){
      incPts = openIncentives[dk]?.[sid] || 0;
      if(incPts > 0){
        const nextOI = {...openIncentives};
        nextOI[dk] = {...nextOI[dk]};
        delete nextOI[dk][sid];
        if(!Object.keys(nextOI[dk]).length) delete nextOI[dk];
        setOpenIncentives(nextOI); await persist("openIncentives", nextOI);
        const nu = users.map(u => u.id === uid ? {...u, points: (u.points||0) + incPts} : u);
        setUsers(nu); await persist("users", nu);
      }
    }
    flash(incPts > 0 ? `Updated · +${incPts} pt incentive credited` : "Updated");
  };
  const updateUser = async (uid,patch) => { const next=users.map(u=>u.id===uid?{...u,...patch}:u); setUsers(next); await persist("users",next); };
  const adjustPoints = async (uid,delta) => { const u=users.find(x=>x.id===uid); await updateUser(uid,{points:Math.max(0,(u?.points||0)+delta)}); };
  const deleteUser = async uid => {
    if(!confirm("Delete this account?")) return;
    const nu=users.filter(u=>u.id!==uid);
    const ns={}; Object.entries(shifts).forEach(([k,day])=>{const c={};Object.entries(day).forEach(([sid,e])=>{if(getUid(e)!==uid)c[sid]=e;});if(Object.keys(c).length)ns[k]=c;});
    const nun={...unavailability}; delete nun[uid];
    const npr={...preferences}; delete npr[uid];
    setUsers(nu);setShifts(ns);setUnavailability(nun);setPreferences(npr);
    await persist("users",nu);await persist("shifts",ns);await persist("unavail",nun);await persist("prefs",npr);
    flash("Removed");
  };

  // Admin-initiated user creation. Generates a readable temp password the admin
  // shares with the new user. The password is hashed before storage — same scheme as self-signup.
  const adminAddUser = async (form) => {
    const name = (form.name||"").trim();
    const username = (form.username||"").trim().toLowerCase();
    if(!name){ return { error: "Name required" }; }
    if(!username){ return { error: "Username required" }; }
    if(users.find(u=>u.username===username)){ return { error: "Username already taken in this group" }; }
    const tempPassword = genCode(8); // readable 8-char alphanumeric (no ambiguous chars)
    const pwHash = await sha256(tempPassword);
    const nu = {
      id: Date.now(),
      username,
      passwordHash: pwHash,
      name,
      role: form.role==="admin" ? "admin" : "provider",
      seniorityId: form.seniorityId ? parseInt(form.seniorityId) : null,
      points: 0,
      targets: { min:0, ideal:0, max:0 },
      email: (form.email||"").trim() || null,
      createdAt: Date.now(),
    };
    const next = [...users, nu]; setUsers(next); await persist("users", next);
    return { user: nu, tempPassword };
  };

  if(loading) return <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500">Loading…</div>;

  /* ══ AUTH SCREEN ══ */
  if(!session||!me){
    const noGroupsYet = groups.length===0;
    const cloudHelper = authMode==="cloud"
      ? (pendingInvite
          ? `Sign in with email to accept your invite to ${pendingInvite.groupName}.`
          : "Sign in with email — we'll send you a one-time link.")
      : null;
    return(
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-3">
        {/* Phase C: cloud account strip + first-device-claim. When the user has a cloud session,
            show their email and a list of cloud groups not yet present on this device. Each
            unclaimed group can be restored from its latest /api/snapshots payload. */}
        {cloudUser && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 flex items-center justify-between">
            <span className="text-xs text-blue-800">Cloud: <span className="font-medium">{cloudUser.user.email}</span></span>
            <button onClick={signOutCloud} className="text-xs text-blue-700 hover:text-blue-900 font-medium">Sign out</button>
          </div>
        )}
        {cloudUser && unclaimedCloudGroups.length>0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <div className="font-semibold text-sm text-slate-900 mb-1">Restore groups from your other device</div>
            <p className="text-xs text-slate-500 mb-3">These cloud groups aren't on this device yet. Restoring fetches the latest snapshot saved by your other device.</p>
            <div className="space-y-2">
              {unclaimedCloudGroups.map(m => (
                <div key={m.groupId} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{m.groupName}</div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide">{m.role}</div>
                  </div>
                  <button onClick={()=>claimCloudGroup(m.groupId, m.groupName)}
                    className="text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg flex-shrink-0">
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-7">
          <div className="mb-1 flex justify-center">
            <ShiftLogoStacked height={140}/>
          </div>
          {pendingInvite && authMode!=="cloud" && (
            <div className="mb-4 px-3 py-2.5 rounded-lg bg-blue-50 border border-blue-200 text-sm">
              <div className="font-medium text-blue-900">You've been invited to <span className="font-semibold">{pendingInvite.groupName}</span></div>
              <div className="text-xs text-blue-700 mt-0.5">Use the <button className="underline font-medium" onClick={()=>{setAuthMode("cloud");setAuthError("");setCloudError("");}}>Cloud</button> tab to accept.</div>
            </div>
          )}
          <p className="text-sm text-slate-500 mb-5">
            {cloudHelper || (authMode==="super"?"Create a new owner account. Existing owners sign in via the Sign in tab.":(noGroupsYet?"No groups yet — an owner must create one first.":"Sign in or join your group."))}
          </p>
          <div className="flex bg-slate-100 rounded-lg p-1 mb-5">
            {[["signin","Sign in"],["signup","Sign up"],["super","Owner"],["cloud","Cloud"]].map(([m,l])=>(
              <button key={m} onClick={()=>{setAuthMode(m);setAuthError("");setCloudError("");setMagicLinkSent(false);}}
                className={`flex-1 py-2 text-xs font-medium rounded-md transition ${authMode===m?"bg-white shadow text-slate-900":"text-slate-500"}`}>
                {l}
              </button>
            ))}
          </div>
          {authMode==="cloud"?(
            magicLinkSent ? (
              <div className="space-y-3 text-sm">
                <div className="px-3 py-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800">
                  Check your inbox — we sent a sign-in link to <span className="font-medium">{cloudEmail}</span>.
                </div>
                <p className="text-xs text-slate-500">The link expires in 15 minutes and can only be used once. You can close this tab.</p>
                <button onClick={()=>{setMagicLinkSent(false);setCloudError("");}}
                  className="w-full text-xs font-medium text-slate-600 hover:text-slate-800 py-2">Send to a different email</button>
              </div>
            ) : (
              <>
                <Field label="Email"><input type="email" value={cloudEmail} autoComplete="email" autoCapitalize="none"
                  onChange={e=>setCloudEmail(e.target.value)}
                  className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:outline-none focus:border-blue-500" placeholder="you@example.com"/></Field>
                <Field label="Password (test users only — leave blank to magic-link)">
                  <input type="password" value={cloudPassword} autoComplete="current-password"
                    onChange={e=>setCloudPassword(e.target.value)}
                    onKeyDown={e=>{
                      if(e.key!=="Enter"||cloudBusy||!cloudEmail.trim()) return;
                      if(cloudPassword) signInWithPassword(cloudEmail, cloudPassword);
                      else requestMagicLink(cloudEmail, pendingInvite?.token);
                    }}
                    className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:outline-none focus:border-blue-500" placeholder=""/>
                </Field>
                {cloudError&&<div className="text-xs text-red-600 mb-3">{cloudError}</div>}
                <button onClick={()=>{
                  if(cloudPassword) signInWithPassword(cloudEmail, cloudPassword);
                  else requestMagicLink(cloudEmail, pendingInvite?.token);
                }}
                  disabled={cloudBusy||!cloudEmail.trim()}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-medium text-base transition disabled:bg-slate-300">
                  {cloudBusy
                    ? (cloudPassword?"Signing in…":"Sending…")
                    : (cloudPassword?"Sign in":(pendingInvite?"Accept invite":"Send magic link"))}
                </button>
                <p className="text-xs text-slate-400 mt-4 text-center">
                  Cloud sign-in is independent of your local account — both keep working.
                </p>
              </>
            )
          ):(<>
          {authMode==="signup"&&(<>
            <Field label="Group code"><input type="text" value={authForm.groupCode} autoCapitalize="characters"
              onChange={e=>setAuthForm({...authForm,groupCode:e.target.value.toUpperCase()})}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base font-mono tracking-wider focus:outline-none focus:border-blue-500" placeholder="ABCD12"/></Field>
            <Field label="Admin code (optional — leave blank to join as provider)"><input type="text" value={authForm.adminCode} autoCapitalize="characters"
              onChange={e=>setAuthForm({...authForm,adminCode:e.target.value.toUpperCase()})}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base font-mono tracking-wider focus:outline-none focus:border-blue-500" placeholder=""/></Field>
            <Field label="Full name"><input type="text" value={authForm.name} onChange={e=>setAuthForm({...authForm,name:e.target.value})}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:outline-none focus:border-blue-500" placeholder="Jane Smith"/></Field>
          </>)}
          {authMode==="super"&&(<>
            <Field label="Full name"><input type="text" value={authForm.name} onChange={e=>setAuthForm({...authForm,name:e.target.value})}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:outline-none focus:border-blue-500" placeholder="Jane Smith"/></Field>
            <Field label="Owner bootstrap code"><input type="text" value={authForm.superBootstrap}
              onChange={e=>setAuthForm({...authForm,superBootstrap:e.target.value})}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base font-mono focus:outline-none focus:border-blue-500"/></Field>
          </>)}
          <Field label="Username"><input type="text" value={authForm.username} autoComplete="username" autoCapitalize="none"
            onChange={e=>setAuthForm({...authForm,username:e.target.value})}
            className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:outline-none focus:border-blue-500"/></Field>
          <Field label="Password"><input type="password" value={authForm.password}
            autoComplete={authMode==="signin"?"current-password":"new-password"}
            onChange={e=>setAuthForm({...authForm,password:e.target.value})}
            onKeyDown={e=>e.key==="Enter"&&handleAuth()}
            className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:outline-none focus:border-blue-500"/></Field>
          {authError&&<div className="text-xs text-red-600 mb-3">{authError}</div>}
          <button onClick={handleAuth} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-medium text-base transition">
            {authMode==="signin"?"Sign in":authMode==="super"?"Create owner account":"Create account"}
          </button>
          {authMode==="signup"&&<p className="text-xs text-slate-400 mt-4 text-center">Group and admin codes come from your group's owner.</p>}
          {authMode==="super"&&<p className="text-xs text-slate-400 mt-4 text-center">An owner bootstrap code is required to create an owner account.</p>}
          </>)}
        </div>
        </div>
        {toast&&<Toast msg={toast}/>}
      </div>
    );
  }

  /* ══ DAY SHEET ══ */
  // v3.1 DaySheet — provider sees a single 4-state segmented control (Top Option / Preferred /
  // Available / Blocked). Top Option expands inline with slot pref + bid. Per-slot panels are
  // read-only for providers (they show the awarded winner or "Open"). Admin keeps slot override.
  const DaySheet = () => {
    if(!editingDay) return null;
    const date=parseDk(editingDay), dayShifts=shifts[editingDay]||{}, base=dayPts(date,config);
    const meUnavail=me.role==="provider"&&isUnavail(me.id,editingDay);
    const meWanted=me.role==="provider"&&isWanted(me.id,editingDay);
    const meTopOpt=me.role==="provider"&&inTopOption(editingDay, me.id);
    const meHasShift=me.role==="provider"&&Object.values(dayShifts).some(e=>getUid(e)===me.id);
    const availPhase = isAvailabilityOpen(currentBlock);
    // Compute which 4-state pill is "active" for the user. (Top Option > Preferred > Blocked > Available default.)
    const activeState = meTopOpt ? "top" : meUnavail ? "blocked" : meWanted ? "preferred" : "available";
    const dayTopOptCount = dayTopOptionerCount(editingDay);
    return(
      <div className="fixed inset-0 bg-black/40 z-50 flex sm:items-center sm:justify-center items-end" onClick={()=>setEditingDay(null)}>
        <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
          <div className="sticky top-0 bg-white border-b border-slate-100 p-4 flex items-center justify-between">
            <div>
              <div className="font-semibold text-lg">{DAYS_LONG[date.getDay()]}</div>
              <div className="text-sm text-slate-500">
                {MONTHS[date.getMonth()]} {date.getDate()}, {date.getFullYear()} · +{base} pts
                {config.holidays[editingDay]&&<span className="text-red-600"> · {config.holidays[editingDay]}</span>}
              </div>
            </div>
            <button onClick={()=>setEditingDay(null)} className="w-9 h-9 flex items-center justify-center text-slate-400 hover:bg-slate-100 rounded-full text-xl">×</button>
          </div>

          {me.role==="provider"&&availPhase&&(
            <div className="px-4 pt-4 space-y-2">
              {/* 4-state segmented control */}
              <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
                <button
                  onClick={async()=>{ if(meUnavail) await toggleUnavail(editingDay); await setTopOption(editingDay, null, TOP_OPTION_DEFAULT_BID); }}
                  disabled={meHasShift}
                  className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${activeState==="top"?"bg-blue-600 text-white shadow-sm":"text-ink-700 hover:text-blue-700"} ${meHasShift?"opacity-40 cursor-not-allowed":""}`}>
                  🎯 Top Option
                </button>
                <button
                  onClick={async()=>{ if(meTopOpt) await clearTopOption(editingDay); if(meUnavail) await toggleUnavail(editingDay); if(!meWanted) await togglePreference(editingDay); }}
                  disabled={meHasShift}
                  className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${activeState==="preferred"?"bg-emerald-500 text-white shadow-sm":"text-ink-700 hover:text-emerald-700"} ${meHasShift?"opacity-40 cursor-not-allowed":""}`}>
                  ⭐ Preferred
                </button>
                <button
                  onClick={async()=>{ if(meTopOpt) await clearTopOption(editingDay); if(meUnavail) await toggleUnavail(editingDay); if(meWanted) await togglePreference(editingDay); }}
                  className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${activeState==="available"?"bg-slate-700 text-white shadow-sm":"text-ink-700 hover:text-slate-900"}`}>
                  Available
                </button>
                <button
                  onClick={async()=>{ if(meTopOpt) await clearTopOption(editingDay); if(meWanted) await togglePreference(editingDay); if(!meUnavail) await toggleUnavail(editingDay); }}
                  disabled={meHasShift && !meUnavail}
                  className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${activeState==="blocked"?"bg-red-500 text-white shadow-sm":"text-ink-700 hover:text-red-700"} ${meHasShift && !meUnavail?"opacity-40 cursor-not-allowed":""}`}>
                  🚫 Blocked
                </button>
              </div>
              {/* Top Option detail panel — slot pref + bid */}
              {meTopOpt&&(()=>{
                const cur = topOptions[editingDay][me.id];
                const myBid = cur.bid;
                const slotPref = cur.slotPref;
                const cap = Math.max(0, Math.floor(totalPts(me.id)));
                return (
                  <div className="bg-brand-50 border border-brand-200 rounded-xl p-3 space-y-3">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-brand-700 mb-1.5">Slot preference</div>
                      <div className="flex gap-1 bg-white rounded-lg p-1 border border-brand-200">
                        {config.shiftSlots.map(s=>(
                          <button key={s.id} type="button" onClick={()=>setSlotPref(editingDay, s.id)}
                            className={`flex-1 text-[11px] font-bold py-1.5 px-2 rounded-md transition ${slotPref===s.id?"text-white shadow-sm":"text-ink-700 hover:bg-brand-50"}`}
                            style={slotPref===s.id?{background:s.color}:{}}>
                            {s.name}
                          </button>
                        ))}
                        <button type="button" onClick={()=>setSlotPref(editingDay, null)}
                          className={`flex-1 text-[11px] font-bold py-1.5 px-2 rounded-md transition ${slotPref==null?"bg-slate-700 text-white shadow-sm":"text-ink-700 hover:bg-slate-100"}`}>
                          Either
                        </button>
                      </div>
                      <div className="text-[10px] text-ink-500 mt-1">Soft preference — if your slot is taken, you cascade to the other open slot.</div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-brand-700">Bid</div>
                        <div className="text-[10px] text-ink-500 mt-0.5">Max you'd spend · actual cost = next-highest bid + 1 (cap <span className="font-bold tabular-nums">{cap}</span> pt{cap===1?"":"s"})</div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button type="button" onClick={()=>setBid(editingDay, myBid-1)} disabled={myBid<=0}
                          className="w-7 h-7 rounded-lg bg-white border border-brand-200 hover:bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-base leading-none disabled:opacity-30">−</button>
                        <input type="number" min="0" max={cap} value={myBid}
                          onChange={e=>{ const n=parseInt(e.target.value); if(!isNaN(n)) setBid(editingDay, n); }}
                          className="v2-num-input w-14 px-1 py-0.5 text-2xl font-extrabold tabular-nums text-center bg-white outline-none border border-brand-200 focus:border-brand-400 rounded-lg text-brand-700"/>
                        <button type="button" onClick={()=>setBid(editingDay, myBid+1)} disabled={myBid>=cap}
                          className="w-7 h-7 rounded-lg bg-white border border-brand-200 hover:bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-base leading-none disabled:opacity-30">+</button>
                      </div>
                    </div>
                    {dayTopOptCount > 1 && (
                      <div className="text-[11px] text-brand-900 italic">
                        {dayTopOptCount-1} other provider{dayTopOptCount===2?"":"s"} also Top-Optioned this day.
                      </div>
                    )}
                  </div>
                );
              })()}
              {meUnavail&&(
                <select value={unavailReason(me.id,editingDay)||""} onChange={e=>setUnavailReason(editingDay,e.target.value)}
                  className="w-full px-3 py-2 border border-red-200 bg-red-50 rounded-lg text-sm">
                  <option value="">— Reason (optional) —</option>
                  {UNAVAIL_REASONS.map(r=><option key={r} value={r}>{r}</option>)}
                </select>
              )}
            </div>
          )}

          <div className="p-4 space-y-3">
            {config.shiftSlots.map(slot=>{
              const entry=dayShifts[slot.id];
              const winnerUid=getUid(entry), winner=winnerUid?users.find(u=>u.id===winnerUid):null;
              const auto=isAuto(entry), isMineWinner=winnerUid===me.id, earned=base*slot.credit;
              return(
                <div key={slot.id} className="border-2 rounded-xl p-3" style={{borderColor:winner?slot.color:"#E2E8F0"}}>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-semibold flex items-center gap-2" style={{color:slot.color}}>
                        {slot.name}
                        {auto&&<span className="bg-blue-100 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 rounded">Auto</span>}
                      </div>
                      <div className="text-xs text-slate-500">
                        {slot.credit}× · {earned.toFixed(earned%1?2:0)} pts
                        {auto&&(()=>{ const wasPref=winnerUid&&(preferences[winnerUid]||[]).includes(editingDay); const b1=config.involuntaryBonus||0, b2=wasPref?0:(config.nonPreferredBonus||0); return (b1+b2)>0?<span className="text-blue-600"> + {b1+b2} bonus{b2>0?<span className="text-[10px]"> ({b1}+{b2} non-pref)</span>:null}</span>:null; })()}
                      </div>
                    </div>
                    {winner?(
                      <div className="flex items-center gap-2">
                        <span className="w-7 h-7 rounded-full text-white flex items-center justify-center text-xs font-semibold" style={{background:COLORS[winner.id%COLORS.length]}}>{initials(winner.name)}</span>
                        <span className="text-sm font-medium">{winner.name}{isMineWinner?" (you)":""}</span>
                      </div>
                    ):(()=>{
                      const inc = openIncentives[editingDay]?.[slot.id] || 0;
                      return (
                        <div className="text-right">
                          <span className="text-sm text-slate-400">Open</span>
                          {inc > 0 && <div className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded mt-0.5">+{inc} pt incentive</div>}
                        </div>
                      );
                    })()}
                  </div>
                  {/* Admin incentive stepper — visible only when slot is open. Bonus pts are minted
                      by the system on award; awardee gets them added to their points balance. */}
                  {me.role==="admin"&&!winner&&(()=>{
                    const inc = openIncentives[editingDay]?.[slot.id] || 0;
                    return (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 mb-2 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-700">Open-shift incentive</div>
                          <div className="text-[10px] text-ink-500 mt-0.5">Bonus pts the awardee earns on top of base.</div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button type="button" onClick={()=>setOpenIncentive(editingDay, slot.id, inc-1)} disabled={inc<=0}
                            className="w-7 h-7 rounded-lg bg-white border border-amber-200 hover:bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-base disabled:opacity-30">−</button>
                          <input type="number" min="0" value={inc} onChange={e=>{ const n=parseInt(e.target.value); if(!isNaN(n)) setOpenIncentive(editingDay, slot.id, n); }}
                            className="v2-num-input w-12 px-1 py-0.5 text-base font-extrabold tabular-nums text-center bg-white outline-none border border-amber-200 focus:border-amber-400 rounded-lg text-amber-700"/>
                          <button type="button" onClick={()=>setOpenIncentive(editingDay, slot.id, inc+1)}
                            className="w-7 h-7 rounded-lg bg-white border border-amber-200 hover:bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-base">+</button>
                        </div>
                      </div>
                    );
                  })()}
                  {me.role==="admin"&&(
                    <div className="space-y-1.5">
                      <select value={winnerUid||""} onChange={e=>adminAssign(editingDay,slot.id,e.target.value?parseInt(e.target.value):null)}
                        className="w-full text-sm border border-slate-300 rounded-lg px-2 py-2 bg-white">
                        <option value="">— Open —</option>
                        {users.filter(u=>u.role==="provider"&&u.seniorityId).map(u=>{
                          const un=isUnavail(u.id,editingDay);
                          const isTopOpt = inTopOption(editingDay, u.id);
                          const sp = getDaySlotPref(editingDay, u.id);
                          const spLabel = sp == null ? "Either" : (config.shiftSlots.find(x=>x.id===sp)?.name || "?");
                          return <option key={u.id} value={u.id} disabled={un}>{u.name}{un?" (unavailable)":""}{isTopOpt?` · 🎯 ${spLabel}`:""}</option>;
                        })}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  /* ══ MODALS ══ */
  const ReconcileModal = () => {
    if(!reconcilePreview) return null;
    const {awarded,deltas} = reconcilePreview;
    const contested = awarded.filter(a=>a.contested);
    const cascaded = awarded.filter(a=>!a.contested&&a.cascaded);
    const auto = awarded.filter(a=>!a.contested&&!a.cascaded);
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setReconcilePreview(null)}>
        <div className="bg-white rounded-2xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e=>e.stopPropagation()}>
          <div className="p-5 border-b border-slate-100">
            <div className="font-semibold text-xl">Close &amp; assign</div>
            {(()=>{
              const totalBid = contested.reduce((s,a)=>s+(a.bid||0),0);
              return (<>
                <p className="text-sm text-slate-500 mt-1">{awarded.length} Top Option {awarded.length===1?"award":"awards"} · {contested.length} contested · {cascaded.length} cascaded · {totalBid} bid pt{totalBid===1?"":"s"} spent</p>
                <p className="text-[11px] text-slate-500 mt-1 italic">Auto-fill (preferred → available) runs after Top Options settle. Block then enters Reconciliation.</p>
              </>);
            })()}
          </div>
          <div className="overflow-y-auto p-5 flex-1 space-y-4">
            {contested.length>0&&(
              <div>
                <div className="text-sm font-medium text-slate-700 mb-2">Contested (2+ Top-Optioners) — winner charged next-highest bid + 1</div>
                <div className="space-y-1.5">{contested.map((a,i)=>{
                  const d=parseDk(a.dateKey), w=users.find(u=>u.id===a.winner);
                  const bid=a.bid||0;
                  return(
                    <div key={i} className="flex items-center gap-2 text-sm py-1">
                      <span className="text-slate-500 w-20 flex-shrink-0">{MONTHS_SHORT[d.getMonth()]} {d.getDate()} {DAYS_SHORT[d.getDay()]}</span>
                      <span className="font-medium text-xs px-2 py-0.5 rounded" style={{background:a.slot.color+"20",color:a.slot.color}}>{a.slot.name}</span>
                      <span className="text-xs text-slate-500">{a.pool.length} Top Option{a.pool.length===1?"":"s"}</span>
                      <span className="font-medium ml-auto">→ {w?.name} {bid>0
                        ? <span className="text-amber-600 text-xs">−{bid} pt{bid===1?"":"s"}</span>
                        : <span className="text-slate-400 text-xs">no bid</span>}</span>
                    </div>
                  );
                })}</div>
              </div>
            )}
            {cascaded.length>0&&(
              <div>
                <div className="text-sm font-medium text-slate-700 mb-2">Cascaded (tie-break loser shifted to open slot)</div>
                <div className="space-y-1.5">{cascaded.map((a,i)=>{
                  const d=parseDk(a.dateKey), w=users.find(u=>u.id===a.winner);
                  return(
                    <div key={i} className="flex items-center gap-2 text-sm py-1">
                      <span className="text-slate-500 w-20 flex-shrink-0">{MONTHS_SHORT[d.getMonth()]} {d.getDate()} {DAYS_SHORT[d.getDay()]}</span>
                      <span className="font-medium text-xs px-2 py-0.5 rounded" style={{background:a.slot.color+"20",color:a.slot.color}}>{a.slot.name}</span>
                      {a.fromSlot&&<span className="text-xs text-slate-500">from {a.fromSlot.name}</span>}
                      <span className="font-medium ml-auto">→ {w?.name}</span>
                    </div>
                  );
                })}</div>
              </div>
            )}
            {auto.length>0&&(
              <div>
                <div className="text-sm font-medium text-slate-700 mb-2">Auto-awarded (single claimant)</div>
                <div className="space-y-1.5">{auto.map((a,i)=>{
                  const d=parseDk(a.dateKey), w=users.find(u=>u.id===a.winner);
                  return(
                    <div key={i} className="flex items-center gap-2 text-sm py-1">
                      <span className="text-slate-500 w-20 flex-shrink-0">{MONTHS_SHORT[d.getMonth()]} {d.getDate()} {DAYS_SHORT[d.getDay()]}</span>
                      <span className="font-medium text-xs px-2 py-0.5 rounded" style={{background:a.slot.color+"20",color:a.slot.color}}>{a.slot.name}</span>
                      <span className="font-medium ml-auto">→ {w?.name}</span>
                    </div>
                  );
                })}</div>
              </div>
            )}
            {awarded.length===0&&<p className="text-sm text-slate-500 text-center py-4">No Top Options to assign.</p>}
          </div>
          <div className="p-4 border-t border-slate-100 flex gap-2">
            <button onClick={()=>setReconcilePreview(null)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={applyReconcile} className="flex-1 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">Close, assign &amp; advance</button>
          </div>
        </div>
      </div>
    );
  };

  // Confirm modal shown when the provider is about to block past their allowed limit.
  // The cap check (checkBlockCapacity) already verified totalPts wouldn't go below 0;
  // this modal lets them choose to "spend" a point on this extra block.
  const ConfirmBlockOverModal = () => {
    if(!confirmBlockOver) return null;
    const { dateKey, penalty, projected } = confirmBlockOver;
    const date = parseDk(dateKey);
    const isWk = isWeekend(dateKey);
    const limitVal = isWk ? config.maxBlockedWeekendDays : config.maxBlockedDays;
    const limitLabel = isWk ? "weekend block" : "block";
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setConfirmBlockOver(null)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-2">⚠️</div>
          <div className="font-bold text-xl mb-2 text-ink-900">Exceed your blocked-days limit?</div>
          <p className="text-sm text-ink-700 mb-3 leading-relaxed">
            Blocking <span className="font-semibold">{MONTHS_SHORT[date.getMonth()]} {date.getDate()}</span> will exceed your {limitLabel} limit of <span className="font-semibold">{limitVal}</span> day{limitVal===1?"":"s"}.
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
            <div className="text-xs font-bold uppercase tracking-wider text-amber-800 mb-1">Cost</div>
            <div className="text-sm text-amber-900">
              <span className="font-bold">−{penalty}</span> point{penalty===1?"":"s"} · your total would drop to <span className="font-bold tabular-nums">{projected.toFixed(1)}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>setConfirmBlockOver(null)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-semibold text-ink-700">Cancel</button>
            <button onClick={async ()=>{ const k = confirmBlockOver.dateKey; setConfirmBlockOver(null); await _applyToggleUnavail(k); }} className="flex-1 py-2.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-semibold">Continue & spend point</button>
          </div>
        </div>
      </div>
    );
  };

  // Block Report — admin-facing breakdown of how every slot in the active block was filled,
  // bucketed by source (pool / cascade / preferred-auto / available-auto / admin / open / pool-pending),
  // plus a per-provider table comparing each provider's total against their min / ideal / max targets.
  // Pure read of current state — safe to open at any phase.
  const BlockReportModal = () => {
    if(!showBlockReport) return null;
    const r = getBlockReport();
    const { totalSlots, bySource, openSlots, pendingPool, perUserRows } = r;
    const filledCount = totalSlots - openSlots - pendingPool;
    // Source labels + colors. Order = display order.
    const SRC_META = [
      { key:"pool",            label:"Filled from pools",        color:"text-blue-700",   bg:"bg-blue-50",   border:"border-blue-100" },
      { key:"cascade",         label:"Filled by cascade",        color:"text-indigo-700", bg:"bg-indigo-50", border:"border-indigo-100" },
      { key:"preferred-auto",  label:"Auto-filled (preferred)",  color:"text-emerald-700",bg:"bg-emerald-50",border:"border-emerald-100" },
      { key:"available-auto",  label:"Auto-filled (available)",  color:"text-amber-700",  bg:"bg-amber-50",  border:"border-amber-100" },
      { key:"admin",           label:"Filled by admin",          color:"text-slate-700",  bg:"bg-slate-100", border:"border-slate-200" },
    ];
    const unknownTotal = (bySource["unknown-auto"]||0) + (bySource["unknown-manual"]||0);
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setShowBlockReport(false)}>
        <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[88vh] overflow-hidden flex flex-col" onClick={e=>e.stopPropagation()}>
          <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
            <div>
              <div className="font-bold text-xl text-ink-900">Block report</div>
              <p className="text-sm text-ink-500 mt-1">
                {currentBlock?.name || "Block"} · {filledCount}/{totalSlots} filled · {openSlots} open · {pendingPool} pending Top Option
              </p>
            </div>
            <button onClick={()=>setShowBlockReport(false)} className="text-ink-400 hover:text-ink-700 text-2xl leading-none px-1">×</button>
          </div>
          <div className="overflow-y-auto p-5 flex-1 space-y-5">
            {/* Source breakdown */}
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.12em] text-ink-500 mb-2">How shifts were filled</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {SRC_META.map(m => (
                  <div key={m.key} className={`${m.bg} ${m.border} border rounded-xl p-3`}>
                    <div className={`text-2xl font-extrabold tabular-nums ${m.color}`}>{bySource[m.key]||0}</div>
                    <div className="text-[11px] text-ink-700 leading-tight mt-0.5">{m.label}</div>
                  </div>
                ))}
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <div className="text-2xl font-extrabold tabular-nums text-ink-900">{openSlots}</div>
                  <div className="text-[11px] text-ink-700 leading-tight mt-0.5">Open shifts remaining</div>
                </div>
              </div>
              {pendingPool > 0 && (
                <p className="text-[11px] text-amber-700 mt-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  ⚠️ {pendingPool} Top Option date{pendingPool===1?" is":"s are"} still pending — close &amp; assign to award.
                </p>
              )}
              {unknownTotal > 0 && (
                <p className="text-[11px] text-ink-500 mt-2 italic">
                  {unknownTotal} legacy entr{unknownTotal===1?"y was":"ies were"} filled before source tagging — listed as "unknown".
                </p>
              )}
            </div>

            {/* Per-provider breakdown */}
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.12em] text-ink-500 mb-2">Per-provider breakdown</div>
              {perUserRows.length===0 ? (
                <p className="text-sm text-ink-500 italic">No providers yet.</p>
              ) : (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500 border-b border-slate-200">
                        <th className="text-left py-2 px-2">Provider</th>
                        <th className="text-right py-2 px-1.5" title="Total awarded shifts">Total</th>
                        <th className="text-right py-2 px-1.5" title="Min / Ideal / Max">M / I / Mx</th>
                        <th className="text-right py-2 px-1.5" title="Top Option wins">Top</th>
                        <th className="text-right py-2 px-1.5" title="Cascaded into other slot">Casc</th>
                        <th className="text-right py-2 px-1.5" title="Preferred-day auto">Pref</th>
                        <th className="text-right py-2 px-1.5" title="Available-day auto">Avail</th>
                        <th className="text-right py-2 px-1.5" title="Admin manual">Adm</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perUserRows.map(row => {
                        const belowMin = row.min > 0 && row.total < row.min;
                        const aboveIdeal = row.ideal > 0 && row.total > row.ideal;
                        const atMax = row.max > 0 && row.total >= row.max;
                        return(
                          <tr key={row.user.id} className="border-b border-slate-100 hover:bg-slate-50">
                            <td className="py-2 px-2 font-medium text-ink-900 truncate">{row.user.name}</td>
                            <td className="py-2 px-1.5 text-right tabular-nums font-semibold">
                              <span className={belowMin ? "text-red-600" : atMax ? "text-amber-600" : aboveIdeal ? "text-emerald-700" : "text-ink-900"}>{row.total}</span>
                            </td>
                            <td className="py-2 px-1.5 text-right tabular-nums text-[11px] text-ink-500">{row.min}/{row.ideal||"—"}/{row.max||"—"}</td>
                            <td className="py-2 px-1.5 text-right tabular-nums text-blue-700">{row.pool||0}</td>
                            <td className="py-2 px-1.5 text-right tabular-nums text-indigo-700">{row.cascade||0}</td>
                            <td className="py-2 px-1.5 text-right tabular-nums text-emerald-700">{row["preferred-auto"]||0}</td>
                            <td className="py-2 px-1.5 text-right tabular-nums text-amber-700">{row["available-auto"]||0}</td>
                            <td className="py-2 px-1.5 text-right tabular-nums text-ink-700">{row.admin||0}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-ink-500 mt-2 italic px-1">
                    Total color: <span className="text-red-600 font-semibold">red</span> = below min · <span className="text-amber-600 font-semibold">amber</span> = at max · <span className="text-emerald-700 font-semibold">green</span> = above ideal.
                  </p>
                </div>
              )}
            </div>
          </div>
          <div className="p-4 border-t border-slate-100 flex justify-end">
            <button onClick={()=>setShowBlockReport(false)} className="px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Close</button>
          </div>
        </div>
      </div>
    );
  };

  const ConfirmResetModal = () => {
    if(!confirmReset) return null;
    let slotCount = 0;
    for(const k of blockDays){
      const day = shifts[k]; if(!day) continue;
      for(const s of config.shiftSlots){
        const e = day[s.id]; if(!e) continue;
        if(getUid(e)) slotCount++;
      }
    }
    // Count days with active Top Options (will be cleared on reset).
    const poolCount = Object.keys(topOptions).filter(k => blockDays.includes(k) && Object.keys(topOptions[k]||{}).length > 0).length;
    const deltaCount = Object.keys(config.lastReconcileDeltas||{}).length;
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setConfirmReset(false)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-2">↺</div>
          <div className="font-semibold text-xl mb-2">Reset block?</div>
          <p className="text-sm text-slate-600 mb-3">This will clear everything on the calendar for the current block and reopen signup so you can run assignments again.</p>
          <ul className="text-sm text-slate-700 space-y-1 mb-4 list-disc list-inside">
            <li><span className="font-medium">{slotCount}</span> awarded slot{slotCount===1?"":"s"} will be cleared.</li>
            <li><span className="font-medium">{poolCount}</span> pending Top Option date{poolCount===1?"":"s"} will be cleared.</li>
            <li>{deltaCount>0?<><span className="font-medium">{deltaCount}</span> user{deltaCount===1?"":"s"} will have winning bids refunded.</>:"No winning bids to refund."}</li>
            <li>Availability, preferences, and targets are <span className="font-medium">kept</span>.</li>
          </ul>
          <div className="flex gap-2">
            <button onClick={()=>setConfirmReset(false)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={resetBlock} className="flex-1 py-2.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium">Reset block</button>
          </div>
        </div>
      </div>
    );
  };

  // Admin moves block from Reconciliation → Locked. (Step 1 of v3 just flips the phase;
  // formal point-distribution-at-lock arrives in step 2 of the build.)
  const ConfirmLockModal = () => {
    if(!confirmLock) return null;
    let assigned=0; for(const k of blockDays){ const day=shifts[k]; if(!day) continue; for(const s of config.shiftSlots){ if(getUid(day[s.id])) assigned++; } }
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setConfirmLock(false)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-2">🔒</div>
          <div className="font-semibold text-xl mb-2">Lock the block?</div>
          <p className="text-sm text-slate-600 mb-3">Moves the block to the <span className="font-semibold">Locked</span> phase. Trades and admin adjustments are still allowed; availability/pool changes are not.</p>
          <ul className="text-sm text-slate-700 space-y-1 mb-4 list-disc list-inside">
            <li><span className="font-medium">{assigned}</span> awarded slot{assigned===1?"":"s"} will be locked in.</li>
            <li>Phase becomes <span className="font-semibold text-slate-700">Locked</span>.</li>
            <li>Use 🔓 Unlock on the dashboard to revert if needed.</li>
          </ul>
          <div className="flex gap-2">
            <button onClick={()=>setConfirmLock(false)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={async()=>{ await updateCurrentBlock({phase:PHASE.LOCKED}); trackEvent("block.lock", { blockId: currentBlock?.id != null ? String(currentBlock.id) : null }); setConfirmLock(false); flash("🔒 Block locked"); }}
              className="flex-1 py-2.5 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium">Lock block</button>
          </div>
        </div>
      </div>
    );
  };

  // Provider modal: enter optional reason for flagging a shift. Every flag is sent to admin for
  // review (silent auto-swap was removed) AND auto-posted to the marketplace at zero incentive.
  const FlagDraftModal = () => {
    if(!flagDraft) return null;
    const { dateKey, slotId } = flagDraft;
    const slot = config.shiftSlots.find(s => s.id === slotId);
    const date = parseDk(dateKey);
    const candidates = findSwapCandidates(dateKey, me.id);
    const preferredCount = candidates.filter(c => c.preferred).length;
    const [reasonState, setReasonState] = [flagDraft.reason || "", (v)=>setFlagDraft({...flagDraft, reason: v})];
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setFlagDraft(null)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-2">⚠️</div>
          <div className="font-semibold text-xl mb-2 text-ink-900">Flag this shift?</div>
          <div className="text-sm text-slate-600 mb-3">
            <span className="font-semibold text-ink-900">{DAYS_LONG[date.getDay()]}, {MONTHS_SHORT[date.getMonth()]} {date.getDate()}</span>
            {" · "}
            <span className="font-medium" style={{color:slot?.color}}>{slot?.name}</span>
          </div>
          <div className="mb-3 rounded-lg border p-3 text-sm bg-amber-50 border-amber-200 text-amber-900">
            <span className="font-bold">Two things happen:</span> the admin gets a swap recommendation panel
            {preferredCount>0 ? <> ({preferredCount} provider{preferredCount===1?"":"s"} preferred this date and {preferredCount===1?"is":"are"} below max)</> : candidates.length>0 ? <> ({candidates.length} eligible provider{candidates.length===1?"":"s"} below max)</> : <> (no obvious swap candidates — admin will need to handle manually)</>},
            and your shift is posted to the marketplace so anyone eligible can take it.
          </div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-wider block mb-1.5">Reason (optional)</label>
          <textarea value={reasonState} onChange={e=>setReasonState(e.target.value)} rows={2}
            placeholder="Conflict, sickness, etc."
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white mb-4 resize-none focus:outline-none focus:border-brand-400"/>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-wider block mb-1.5">Reason (optional)</label>
          <textarea value={reasonState} onChange={e=>setReasonState(e.target.value)} rows={2}
            placeholder="Conflict, sickness, etc."
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white mb-4 resize-none focus:outline-none focus:border-brand-400"/>
          <div className="flex gap-2">
            <button onClick={()=>setFlagDraft(null)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={()=>flagShift(dateKey, slotId, reasonState)}
              className="flex-1 py-2.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium">
              Flag &amp; notify admin
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Provider modal: post an awarded shift to the marketplace for take, with optional incentive.
  const ListDraftModal = () => {
    if(!listDraft) return null;
    const { dateKey, slotId } = listDraft;
    const slot = config.shiftSlots.find(s => s.id === slotId);
    const date = parseDk(dateKey);
    const cap = Math.max(0, Math.floor(me.points || 0));
    const inc = Math.max(0, Math.min(cap, parseInt(listDraft.incentivePts)||0));
    const setInc = (v) => setListDraft({...listDraft, incentivePts: Math.max(0, Math.min(cap, parseInt(v)||0))});
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setListDraft(null)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-2">📣</div>
          <div className="font-semibold text-xl mb-2 text-ink-900">Post for take</div>
          <div className="text-sm text-slate-600 mb-4">
            <span className="font-semibold text-ink-900">{DAYS_LONG[date.getDay()]}, {MONTHS_SHORT[date.getMonth()]} {date.getDate()}</span>
            {" · "}
            <span className="font-medium" style={{color:slot?.color}}>{slot?.name}</span>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-xs text-amber-900">
            Anyone eligible can claim this shift. The shift's earned points still go to whoever ends up working it. Add an <span className="font-bold">incentive</span> below if you want to spend some of your own points to make the offer more attractive.
          </div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-wider block mb-2">Incentive points (max {cap})</label>
          <div className="flex items-center gap-2 mb-4">
            <button type="button" onClick={()=>setInc(inc-1)} disabled={inc<=0}
              className="w-9 h-9 rounded-lg bg-white border border-amber-200 hover:bg-amber-50 text-amber-700 flex items-center justify-center font-bold text-base disabled:opacity-30">−</button>
            <input type="number" min="0" max={cap} value={inc} onChange={e=>setInc(e.target.value)}
              className="v2-num-input flex-1 px-2 py-2 text-2xl font-extrabold tabular-nums text-center bg-white border border-amber-200 focus:border-amber-400 outline-none rounded-lg text-amber-700"/>
            <button type="button" onClick={()=>setInc(inc+1)} disabled={inc>=cap}
              className="w-9 h-9 rounded-lg bg-white border border-amber-200 hover:bg-amber-50 text-amber-700 flex items-center justify-center font-bold text-base disabled:opacity-30">+</button>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>setListDraft(null)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={()=>postForTake(dateKey, slotId, inc)}
              className="flex-1 py-2.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium">
              Post {inc>0?`with +${inc} pt${inc===1?"":"s"}`:"(no incentive)"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Two-sided trade composer: pick one of the user's awarded shifts to offer in exchange for the
  // listing, plus an optional incentive sweetener. Driven by `tradeDraft = { listingId }`.
  const TradeDraftModal = () => {
    if(!tradeDraft) return null;
    const listing = marketplace.find(l => l.id === tradeDraft.listingId);
    if(!listing) { setTradeDraft(null); return null; }
    const lSlot = config.shiftSlots.find(s => s.id === listing.slotId);
    const lDate = parseDk(listing.dateKey);
    const seller = users.find(u => u.id === listing.sellerId);
    // The user's own awarded shifts in this block, eligible to be offered.
    const myShifts = [];
    Object.entries(shifts).forEach(([k, day]) => {
      if(!inBlock(k, config)) return;
      Object.entries(day).forEach(([sidStr, e]) => {
        if(getUid(e) !== me.id) return;
        const sid = parseInt(sidStr);
        // Filter: don't offer the same date as the listing (would create same-day conflict).
        if(k === listing.dateKey) return;
        myShifts.push({ k, sid, date: parseDk(k), slot: config.shiftSlots.find(s => s.id === sid) });
      });
    });
    myShifts.sort((a,b) => a.k.localeCompare(b.k));
    const cap = Math.max(0, Math.floor(me.points || 0));
    const sel = tradeDraft.offererDateKey && tradeDraft.offererSlotId ? { k: tradeDraft.offererDateKey, sid: tradeDraft.offererSlotId } : null;
    const inc = Math.max(0, Math.min(cap, parseInt(tradeDraft.incentivePts)||0));
    const setInc = (v) => setTradeDraft({...tradeDraft, incentivePts: Math.max(0, Math.min(cap, parseInt(v)||0))});
    const pickShift = (k, sid) => setTradeDraft({...tradeDraft, offererDateKey: k, offererSlotId: sid});
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setTradeDraft(null)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-2">🔁</div>
          <div className="font-semibold text-xl mb-1 text-ink-900">Offer trade</div>
          <p className="text-sm text-slate-600 mb-4">
            For: <span className="font-semibold text-ink-900">{DAYS_LONG[lDate.getDay()]}, {MONTHS_SHORT[lDate.getMonth()]} {lDate.getDate()}</span>
            {" · "}<span className="font-medium" style={{color:lSlot?.color}}>{lSlot?.name}</span>
            {" · from "}{seller?.name||"?"}
          </p>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-wider block mb-2">Pick one of your shifts to offer</label>
          {myShifts.length === 0
            ? <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4 text-xs text-slate-600">You have no other awarded shifts to offer in trade. Use <span className="font-semibold">Take</span> instead.</div>
            : <div className="space-y-1.5 mb-4">{myShifts.map(s => {
                const active = sel && sel.k === s.k && sel.sid === s.sid;
                return (
                  <button key={`${s.k}_${s.sid}`} type="button" onClick={()=>pickShift(s.k, s.sid)}
                    className={`w-full flex items-center gap-2.5 p-2.5 rounded-lg border-2 transition text-left ${active?"border-blue-500 bg-blue-50":"border-slate-200 bg-white hover:bg-slate-50"}`}>
                    <div className="w-10 h-10 rounded-lg bg-slate-50 flex flex-col items-center justify-center flex-shrink-0">
                      <div className="text-[9px] font-bold text-slate-500">{DAYS_SHORT[s.date.getDay()]}</div>
                      <div className="text-base font-bold leading-tight">{s.date.getDate()}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{MONTHS_SHORT[s.date.getMonth()]} {s.date.getDate()}</div>
                      <div className="text-xs font-medium" style={{color:s.slot?.color}}>{s.slot?.name}</div>
                    </div>
                    {active && <span className="text-blue-600 text-lg">✓</span>}
                  </button>
                );
              })}</div>
          }
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-wider block mb-2">Sweetener points (optional, max {cap})</label>
          <div className="flex items-center gap-2 mb-1">
            <button type="button" onClick={()=>setInc(inc-1)} disabled={inc<=0}
              className="w-9 h-9 rounded-lg bg-white border border-blue-200 hover:bg-blue-50 text-blue-700 flex items-center justify-center font-bold text-base disabled:opacity-30">−</button>
            <input type="number" min="0" max={cap} value={inc} onChange={e=>setInc(e.target.value)}
              className="v2-num-input flex-1 px-2 py-2 text-2xl font-extrabold tabular-nums text-center bg-white border border-blue-200 focus:border-blue-400 outline-none rounded-lg text-blue-700"/>
            <button type="button" onClick={()=>setInc(inc+1)} disabled={inc>=cap}
              className="w-9 h-9 rounded-lg bg-white border border-blue-200 hover:bg-blue-50 text-blue-700 flex items-center justify-center font-bold text-base disabled:opacity-30">+</button>
          </div>
          <p className="text-[11px] text-slate-500 mb-4">{listing.incentivePts>0 ? <>You'll receive <span className="font-bold">+{listing.incentivePts}</span> pt{listing.incentivePts===1?"":"s"} from {seller?.name?.split(" ")[0]||"the lister"} on accept. </> : null}{inc>0 ? `You give them +${inc} pt${inc===1?"":"s"}.` : "No sweetener — pure shift swap."}</p>
          <div className="flex gap-2">
            <button onClick={()=>setTradeDraft(null)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={()=>sel && offerTrade(tradeDraft.listingId, sel.k, sel.sid, inc)} disabled={!sel}
              className="flex-1 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed">
              Send offer
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Admin-only: form for adding a new user to the current group with a generated temp password.
  const AddUserModal = () => {
    if(!addUserOpen) return null;
    // Cloud test/real toggle is only meaningful when this group is cloud-mirrored AND the admin
    // is cloud-signed-in. Otherwise we're creating local-only.
    const cloudCreatable = !!(cloudUser && currentGroup?.cloudGroupId);
    const isTest = !!addUserForm.isTest;
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setAddUserOpen(false)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-xl">Add user</div>
            <button onClick={()=>setAddUserOpen(false)} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:bg-slate-100 rounded-full text-xl leading-none">×</button>
          </div>
          <p className="text-sm text-slate-500 mb-4">
            {isTest
              ? "Test user — synthetic email, password handed to you to share. No magic-link email is sent."
              : "We'll generate a temporary password you can share. They can sign in with their username and the temp password right away."}
          </p>
          <Field label="Full name"><input type="text" value={addUserForm.name}
            onChange={e=>setAddUserForm({...addUserForm,name:e.target.value})}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="Jane Smith"/></Field>
          <Field label="Username"><input type="text" value={addUserForm.username} autoCapitalize="none"
            onChange={e=>setAddUserForm({...addUserForm,username:e.target.value})}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="jsmith"/></Field>
          {!isTest && (
            <Field label="Email (optional — used to prefill the email share)"><input type="email" value={addUserForm.email}
              onChange={e=>setAddUserForm({...addUserForm,email:e.target.value})}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="jane@example.com"/></Field>
          )}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <Field label="Role">
              <select value={addUserForm.role} onChange={e=>setAddUserForm({...addUserForm,role:e.target.value})}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                <option value="provider">Provider</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            {addUserForm.role==="provider"&&(
              <Field label="Seniority (optional)">
                <select value={addUserForm.seniorityId} onChange={e=>setAddUserForm({...addUserForm,seniorityId:e.target.value})}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                  <option value="">— Unassigned —</option>
                  {config.seniorityLevels.map(l=><option key={l.id} value={l.id}>{l.name} (min {l.minShifts||0})</option>)}
                </select>
              </Field>
            )}
          </div>
          {cloudCreatable && (
            <label className="flex items-center gap-2 text-sm text-slate-700 mb-3 cursor-pointer">
              <input type="checkbox" checked={isTest}
                onChange={e=>setAddUserForm({...addUserForm,isTest:e.target.checked})}
                className="rounded border-slate-300"/>
              Test user (synthetic email, no magic-link sent)
            </label>
          )}
          <button onClick={async()=>{
              const result = await adminAddUser(addUserForm);
              if(result.error){ flash("⚠️ " + result.error); return; }
              // Phase D.1: also create a cloud user + membership when this group is cloud-mirrored.
              // Local and cloud have separate passwords and identifiers — admin sees both in the
              // result modal and can hand out whichever fits the testing scenario.
              let cloud = null;
              if (cloudCreatable) {
                try {
                  const r = await window.api.fetchJSON("/api/users", {
                    method: "POST",
                    body: JSON.stringify({
                      kind: isTest ? "test" : "real",
                      role: result.user.role,
                      displayName: result.user.name,
                      email: isTest ? undefined : (result.user.email || addUserForm.email || undefined),
                      groupId: currentGroup.cloudGroupId,
                      localUid: String(result.user.id),
                    }),
                  });
                  cloud = { email: r.email, kind: r.kind, tempPassword: r.tempPassword };
                } catch (e) {
                  flash("⚠️ Local user created; cloud creation failed");
                }
              }
              setNewUserResult({
                name: result.user.name,
                username: result.user.username,
                tempPassword: result.tempPassword,
                email: result.user.email,
                role: result.user.role,
                cloud,
              });
              setAddUserOpen(false);
              setAddUserForm({ name:"", username:"", email:"", role:"provider", seniorityId:"", isTest:false });
            }}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-sm font-medium">
            Generate account
          </button>
        </div>
      </div>
    );
  };

  // Shown after adminAddUser succeeds. Displays username + temp password with copy / email share helpers.
  // Phase D.1: when a cloud user was also created (test or real), shows the cloud credentials in a
  // separate panel so the admin can hand out either path.
  const NewUserInfoModal = () => {
    if(!newUserResult) return null;
    const { name, username, tempPassword, email, role, cloud } = newUserResult;
    const gc = currentGroup?.groupCode || "";
    const body = [
      `Hi ${name.split(" ")[0]},`,
      ``,
      `You've been added to our shift scheduling app as a ${role}.`,
      ``,
      `Username: ${username}`,
      `Temporary password: ${tempPassword}`,
      gc?`Group code (only needed if signing up fresh): ${gc}`:"",
      ``,
      `Open the app and sign in with your username + the temporary password above.`,
    ].filter(Boolean).join("\n");
    const mailto = `mailto:${email||""}?subject=${encodeURIComponent("Your SHIFT login")}&body=${encodeURIComponent(body)}`;
    const copyInfo = () => { try { navigator.clipboard?.writeText(body); flash("Login info copied"); } catch { flash("⚠️ Copy failed"); } };
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setNewUserResult(null)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-1">✅</div>
          <div className="font-semibold text-xl mb-1">Account created</div>
          <p className="text-sm text-slate-500 mb-4">Share these credentials with <span className="font-medium">{name}</span>. They can sign in immediately.</p>
          <div className="bg-slate-50 rounded-lg p-3 mb-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Username</div>
                <div className="font-mono text-sm font-semibold text-slate-800">{username}</div>
              </div>
              <button onClick={()=>{try{navigator.clipboard?.writeText(username);flash("Username copied");}catch{}}}
                className="text-[11px] text-blue-600 hover:text-blue-800 font-medium">Copy</button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Temporary password</div>
                <div className="font-mono text-base font-bold tracking-wider text-slate-900">{tempPassword}</div>
              </div>
              <button onClick={()=>{try{navigator.clipboard?.writeText(tempPassword);flash("Password copied");}catch{}}}
                className="text-[11px] text-blue-600 hover:text-blue-800 font-medium">Copy</button>
            </div>
          </div>
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-3">This password is shown only once. Copy it now — after you close this dialog there's no way to retrieve it (you'd have to delete and re-add the user).</p>
          {cloud && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 space-y-2">
              <div className="text-xs font-semibold text-blue-900 uppercase tracking-wide">
                {cloud.kind==="test" ? "Cloud sign-in (test user)" : "Cloud sign-in (real user)"}
              </div>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-medium text-blue-700 uppercase tracking-wide">Email</div>
                  <div className="font-mono text-xs text-slate-800 break-all">{cloud.email}</div>
                </div>
                <button onClick={()=>{try{navigator.clipboard?.writeText(cloud.email);flash("Email copied");}catch{}}}
                  className="text-[11px] text-blue-700 hover:text-blue-900 font-medium flex-shrink-0">Copy</button>
              </div>
              {cloud.tempPassword ? (
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-medium text-blue-700 uppercase tracking-wide">Cloud password</div>
                    <div className="font-mono text-base font-bold tracking-wider text-slate-900">{cloud.tempPassword}</div>
                  </div>
                  <button onClick={()=>{try{navigator.clipboard?.writeText(cloud.tempPassword);flash("Cloud password copied");}catch{}}}
                    className="text-[11px] text-blue-700 hover:text-blue-900 font-medium flex-shrink-0">Copy</button>
                </div>
              ) : (
                <div className="text-[11px] text-blue-700">A magic-link sign-in email was sent to this address.</div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={copyInfo} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">📋 Copy login info</button>
            <a href={mailto} className="flex-1 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-center">
              ✉️ Email it
            </a>
          </div>
          <button onClick={()=>setNewUserResult(null)} className="w-full mt-2 py-2 text-sm text-slate-500 hover:text-slate-700">Done</button>
        </div>
      </div>
    );
  };

  const Onboarding = () => {
    if(!showOnboarding) return null;
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl p-6 max-w-md w-full">
          <div className="text-3xl mb-3">⭐</div>
          <div className="font-semibold text-xl mb-3">Quick guide</div>
          <div className="space-y-3 text-sm text-slate-600 mb-5">
            <p><span className="font-semibold text-slate-900">1. Set your targets.</span> Tell us the minimum, ideal, and maximum shifts you want this block.</p>
            <p><span className="font-semibold text-slate-900">2. Mark preferred dates to work.</span> On the Availability page, star any days you'd prefer. Auto-assign uses this to fill leftover slots.</p>
            <p><span className="font-semibold text-slate-900">3. Set Top Options for the days you really want.</span> On the Schedule page, pick <span className="font-semibold text-slate-900">🎯 Top Option</span> for any day you're committing to. You'll choose a slot preference (Primary / Backup / Either) and a bid — defaults to <span className="font-semibold text-slate-900">1 point</span>, but you can bid higher (up to your current points) to outweigh other Top-Optioners on the same day.</p>
            <p><span className="font-semibold text-slate-900">4. Block what you can't.</span> Optionally classify (Working, Vacation, Conference, Personal Conflict). You may block up to {config.maxBlockedDays} days ({config.maxBlockedWeekendDays} weekend) — going over costs a point per extra day. You also need to prefer at least {config.minPreferredDays} days ({config.minPreferredWeekendDays} weekend) or lose points.</p>
            <p><span className="font-semibold text-slate-900">5. Settled at close.</span> When the admin closes the window, contested days go to the <span className="font-semibold text-slate-900">highest bidder</span> (ties fall to highest current points). The winner pays the <span className="font-semibold text-slate-900">next-highest bid + 1</span> — never their full bid. So bidding 7 against a 2 costs you 3, not 7. Solo Top Options cost 1.</p>
          </div>
          <button onClick={()=>setShowOnboarding(false)} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-medium">Got it</button>
        </div>
      </div>
    );
  };

  const AutoAssignModal = () => {
    if(!autoPreview) return null;
    const {newAssignments,unfilled}=autoPreview;
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setAutoPreview(null)}>
        <div className="bg-white rounded-2xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={e=>e.stopPropagation()}>
          <div className="p-5 border-b border-slate-100">
            <div className="font-semibold text-xl">Auto-assign preview</div>
            <p className="text-sm text-slate-500 mt-1">{newAssignments.length} new · {unfilled.length} unfillable</p>
          </div>
          <div className="overflow-y-auto p-5 flex-1">
            {newAssignments.length===0?<p className="text-sm text-slate-500 text-center py-4">Nothing to fill.</p>:(
              <div className="space-y-1.5">{newAssignments.map((a,i)=>{
                const date=parseDk(a.dateKey);
                return(
                  <div key={i} className="flex items-center gap-2 text-sm py-1">
                    <span className="text-slate-500 w-20 flex-shrink-0">{MONTHS_SHORT[date.getMonth()]} {date.getDate()} {DAYS_SHORT[date.getDay()]}</span>
                    <span className="font-medium text-xs px-2 py-0.5 rounded" style={{background:a.slot.color+"20",color:a.slot.color}}>{a.slot.name}</span>
                    <span className="font-medium ml-auto">→ {a.user.name}</span>
                  </div>
                );
              })}</div>
            )}
            {unfilled.length>0&&(
              <div className="mt-4 p-3 bg-red-50 rounded-lg">
                <div className="text-sm font-medium text-red-900 mb-1">⚠️ {unfilled.length} slot(s) unfillable</div>
                <p className="text-xs text-red-700">Everyone is unavailable. Manual assignment needed.</p>
              </div>
            )}
          </div>
          <div className="p-4 border-t border-slate-100 flex gap-2">
            <button onClick={()=>setAutoPreview(null)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={applyAutoAssign} disabled={newAssignments.length===0}
              className="flex-1 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50">Apply all</button>
          </div>
        </div>
      </div>
    );
  };

  /* ══ CALENDAR ══ */
  const CalendarView = () => {
    const md=dim(calY,calM), off=fdow(calY,calM);
    const cells=[...Array(off).fill(null),...Array.from({length:md},(_,i)=>i+1)];
    return(
      <div>
        <div className="flex items-center justify-between mb-4">
          <button onClick={()=>{if(calM===0){setCalM(11);setCalY(calY-1);}else setCalM(calM-1);}} className="px-3 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50 text-lg">‹</button>
          <span className="font-semibold text-base sm:text-lg">{MONTHS[calM]} {calY}</span>
          <button onClick={()=>{if(calM===11){setCalM(0);setCalY(calY+1);}else setCalM(calM+1);}} className="px-3 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50 text-lg">›</button>
        </div>
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DAYS_SHORT.map(d=><div key={d} className="text-[10px] sm:text-xs font-medium text-slate-500 text-center py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d,i)=>{
            if(d===null) return <div key={`e${i}`} className="aspect-square"/>;
            const key=dk(calY,calM,d), date=parseDk(key), inB=inBlock(key,config), pts=dayPts(date,config);
            const dayS=shifts[key]||{}, hol=config.holidays[key];
            const awarded=config.shiftSlots.map(s=>({s,uid:getUid(dayS[s.id]),auto:isAuto(dayS[s.id])})).filter(x=>x.uid);
            const filled=awarded.length, total=config.shiftSlots.length;
            // v3.1: pool concept now lives at day level via topOptions.
            const dayTopCount = dayTopOptionerCount(key);
            const availPhase = isAvailabilityOpen(currentBlock);
            const myUnRaw=me.role==="provider"&&isUnavail(me.id,key);
            const myWantRaw=me.role==="provider"&&isWanted(me.id,key);
            const myTopRaw=me.role==="provider"&&inTopOption(key, me.id);
            const myUn = availPhase && myUnRaw;     // only honored in Availability
            const myWant = availPhase && myWantRaw;
            const myTop = availPhase && myTopRaw;
            const myShift=me.role==="provider"&&awarded.some(x=>x.uid===me.id);
            // When filter is on, check if the selected user is on this day (awarded or has Top Option).
            const filterHit=filterUid?awarded.some(x=>x.uid===filterUid)||inTopOption(key, filterUid):false;
            const dimmed=filterUid&&inB&&!filterHit;
            const bg=!inB?"bg-slate-50":myUn?"bg-red-100":hol?"bg-green-100":pts===0?"bg-blue-50":pts===1?"bg-blue-100":pts===2?"bg-amber-100":pts===3?"bg-amber-200":"bg-amber-300";
            const insights = dayInsights(key);
            const adminChallenging = !!insights?.challenging;
            const adminHasAuto = !!insights?.hasAuto;
            // Ring: filter match (purple) > my shift (green) > my Top Option (blue) > admin challenge (orange).
            const ring=filterUid?(filterHit?"ring-2 ring-purple-500":""):(myShift?"ring-2 ring-green-500":myTop?"ring-2 ring-blue-400":adminChallenging?"ring-2 ring-orange-500":"");
            return(
              <div key={key} role={inB?"button":undefined} tabIndex={inB?0:-1} aria-disabled={!inB}
                className={`aspect-square rounded-lg p-1 sm:p-1.5 flex flex-col text-[10px] ${bg} ${inB?"active:scale-95 hover:ring-2 hover:ring-blue-400 cursor-pointer":"opacity-40 cursor-default"} ${ring} ${dimmed?"opacity-30":""}`}
                onClick={()=>inB&&setEditingDay(key)}
                onKeyDown={inB?(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault(); setEditingDay(key);}}:undefined}>
                <div className="flex items-center justify-between leading-none gap-0.5">
                  <span className="font-semibold text-slate-700 text-xs flex items-center gap-0.5 min-w-0">
                    {adminChallenging&&<span className="text-orange-600" title="Hard to fill — nobody preferred, most blocked, all slots auto-assigned">⚠</span>}
                    <span>{d}</span>
                    {/* v3.1 inline state markers: 🎯 Top Option (blue) > ⭐ Preferred (emerald) > ✕ Blocked (red).
                        These are read-only indicators — tap the cell to open DaySheet for changes. */}
                    {me.role==="provider"&&inB&&availPhase&&(
                      myTopRaw ? <span className="leading-none text-[12px] sm:text-[13px] text-blue-600" title="Top Option · tap to edit">🎯</span>
                      : myWantRaw ? <span className="leading-none text-[12px] sm:text-[13px] text-emerald-500" title="Preferred · tap to edit">★</span>
                      : myUnRaw ? <span className="leading-none text-[10px] sm:text-[11px] font-bold text-red-600" title="Blocked · tap to edit">✕</span>
                      : null
                    )}
                  </span>
                  <span className="flex items-center gap-0.5 flex-shrink-0">
                    {adminHasAuto&&!adminChallenging&&<span className="text-[9px] text-amber-600" title="Contains auto-assigned slots">⚙</span>}
                    {availPhase && me.role==="admin" && dayTopCount>0 && <span className="text-[9px] text-blue-600 font-bold" title={`${dayTopCount} Top Option${dayTopCount===1?"":"s"}`}>🎯{dayTopCount}</span>}
                    {pts>0&&<span className="text-[9px] text-slate-500">+{pts}</span>}
                  </span>
                </div>
                {hol&&<div className="text-[8px] text-green-800 truncate leading-tight mt-0.5">{hol}</div>}
                {!inB?null:myUn?(
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-[10px] sm:text-[11px] font-bold text-red-700">✕ BLOCKED</span>
                  </div>
                ):(
                  // Read-only per-slot chips. The "Open" chip is no longer a join button —
                  // Top Option commitment lives at the day level and is set via DaySheet (or list view).
                  <div className="flex-1 flex flex-col justify-center w-full gap-0.5 overflow-hidden py-0.5">
                    {config.shiftSlots.map(s=>{
                      const entry=dayS[s.id];
                      const winUid=getUid(entry), u=winUid?users.find(uu=>uu.id===winUid):null;
                      const isMe=winUid===me.id, isFilt=filterUid&&winUid===filterUid, auto=isAuto(entry);
                      if(u) return(
                        <div key={s.id}
                          className={`text-[9px] sm:text-[10px] px-1 py-0.5 rounded leading-tight truncate font-medium ${isMe?"bg-green-100 text-green-800":isFilt?"bg-purple-100 text-purple-800":"text-white"}`}
                          style={!isMe&&!isFilt?{background:s.color}:{}} title={`${s.name}: ${u.name}${auto?" (auto)":""}`}>
                          {u.name.split(" ")[0]}{auto?" ⚙":""}
                        </div>
                      );
                      return (
                        <div key={s.id}
                          className="text-[9px] sm:text-[10px] px-1 py-0.5 rounded leading-tight truncate font-bold bg-white"
                          style={{border:`1.5px solid ${s.color}`, color:s.color}}
                          title={`${s.name}: open`}>
                          {s.name}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-[11px] text-slate-500">
          <Legend color="bg-blue-50" label="0 pts"/><Legend color="bg-blue-100" label="+1"/>
          <Legend color="bg-amber-100" label="+2"/><Legend color="bg-amber-200" label="+3"/><Legend color="bg-amber-300" label="+4"/>
          {me.role==="provider"&&<Legend color="bg-red-100" label="Blocked"/>}
          {me.role==="provider"&&<span className="flex items-center gap-1"><span className="text-emerald-500">⭐</span>Preferred</span>}
          {me.role==="provider"&&<span className="flex items-center gap-1"><span className="text-blue-600">🎯</span>Top Option</span>}
          {me.role==="provider"&&<Legend ring="ring-2 ring-blue-400" label="Your Top Option"/>}
          <Legend ring="ring-2 ring-green-500" label="Awarded"/>
          {filterUid&&<Legend ring="ring-2 ring-purple-500" label="Filtered user"/>}
          {me.role==="admin"&&<Legend ring="ring-2 ring-orange-500" label="⚠ Hard to fill"/>}
          {me.role==="admin"&&<span className="flex items-center gap-1"><span className="text-amber-600">⚙</span>Auto-filled</span>}
        </div>
      </div>
    );
  };

  /* ══ LIST VIEW ══ */
  const ListView = () => {
    if(!blockDays.length) return <p className="text-sm text-slate-500 text-center py-8">No block dates set.</p>;
    // When a provider filter is active, only render days where the selected user has an awarded shyft or is in a pool.
    const visibleDays = filterUid
      ? blockDays.filter(k=>{
          const day = shifts[k]||{};
          return Object.values(day).some(e=>getUid(e)===filterUid) || inTopOption(k, filterUid);
        })
      : blockDays;
    if(filterUid && visibleDays.length===0) return <p className="text-sm text-slate-500 text-center py-8">No shifts yet for this user.</p>;
    return(
      <div className="space-y-2">
        {visibleDays.map(k=>{
          const date=parseDk(k), dayS=shifts[k]||{}, base=dayPts(date,config), hol=config.holidays[k];
          const myUn=me.role==="provider"&&isUnavail(me.id,k);
          const myShift=me.role==="provider"&&Object.values(dayS).some(e=>getUid(e)===me.id);
          const filled=Object.values(dayS).filter(e=>getUid(e)).length, total=config.shiftSlots.length;
          const myWant=me.role==="provider"&&isWanted(me.id,k);
          const pillBg=base===0?"bg-slate-100 text-slate-600":base===1?"bg-blue-100 text-blue-700":base===2?"bg-amber-100 text-amber-800":base===3?"bg-amber-200 text-amber-900":"bg-amber-300 text-amber-900";
          const insights=dayInsights(k);
          const adminChallenging=!!insights?.challenging;
          const adminHasAuto=!!insights?.hasAuto;
          return(
            <button key={k} onClick={()=>setEditingDay(k)}
              className={`w-full border rounded-xl p-3 flex items-center gap-3 active:bg-slate-50 text-left ${myShift?"bg-white border-green-400 border-2":myUn?"bg-red-50 border-red-300":adminChallenging?"bg-orange-50 border-orange-400 border-2":"bg-white border-slate-200"}`}>
              <div className="w-12 h-12 rounded-lg bg-slate-50 flex flex-col items-center justify-center flex-shrink-0">
                <div className="text-[10px] font-semibold text-slate-500 leading-none">{DAYS_SHORT[date.getDay()]}</div>
                <div className="text-lg font-bold leading-tight">{date.getDate()}</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                  <span className="font-medium text-sm">{MONTHS_SHORT[date.getMonth()]} {date.getDate()}{myWant?<span className="text-emerald-500 ml-0.5">⭐</span>:""}</span>
                  {base>0&&<span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${pillBg}`}>+{base}</span>}
                  {hol&&<span className="text-[10px] bg-green-100 text-green-800 px-1.5 py-0.5 rounded-full truncate">{hol}</span>}
                  {myUn&&<span className="text-[10px] bg-red-200 text-red-900 px-1.5 py-0.5 rounded-full font-semibold">✕ Blocked</span>}
                  {adminChallenging&&(
                    <span className="text-[10px] bg-orange-100 text-orange-800 border border-orange-300 px-1.5 py-0.5 rounded-full font-semibold"
                      title={`${insights.blockedCount}/${insights.totalProvs} blocked · 0 preferred · all slots auto-assigned`}>
                      ⚠ Hard to fill
                    </span>
                  )}
                  {adminHasAuto&&!adminChallenging&&(
                    <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full font-medium">⚙ Auto-filled</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {config.shiftSlots.map(s=>{
                    const entry=dayS[s.id], winUid=getUid(entry), u=winUid?users.find(x=>x.id===winUid):null;
                    const isMe=winUid===me.id, auto=isAuto(entry);
                    if(u) return(
                      <span key={s.id} className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${isMe?"bg-green-100 text-green-800":"text-white"}`}
                        style={!isMe?{background:s.color}:{}}>
                        {s.name}: {isMe?"You":u.name.split(" ")[0]}{auto?" ⚙":""}
                      </span>
                    );
                    return <span key={s.id} className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-white border-2"
                      style={{borderColor:s.color, color:s.color}}>
                      {s.name}: Open
                    </span>;
                  })}
                  {/* v3.1: Top Option count is per-day, not per-slot. Surface once at the end of the row. */}
                  {(()=>{ const n = dayTopOptionerCount(k); return n > 0 ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-blue-100 text-blue-800 border border-blue-300">
                      🎯 {n} Top Option{n===1?"":"s"}
                    </span>
                  ) : null; })()}
                </div>
              </div>
              <div className={`text-xs font-semibold flex-shrink-0 ${filled===total?"text-slate-400":filled===0?"text-blue-600":"text-amber-600"}`}>{filled}/{total}</div>
            </button>
          );
        })}
      </div>
    );
  };

  /* ══ PAGES ══ */
  const ProviderHome = () => {
    const earned=getPtsEarned(me.id), count=getShiftCount(me.id), autoC=getAutoCount(me.id);
    const avail=getAvailInfo(me.id), total=me.points+earned-avail.penalty;
    const min=mySeniority?.minShifts||0, rem=Math.max(0,min-count);
    return(<>
      <h1 className="text-2xl font-semibold mb-1">Hi, {me.name.split(" ")[0]}</h1>
      <p className="text-sm text-slate-500 mb-5">
        {mySeniority?<>Set as <span className="font-medium text-slate-700">{mySeniority.name}</span> · min {min} shifts</>:<span className="text-amber-600">Waiting for admin to assign your seniority.</span>}
      </p>
      {autoC>0&&(()=>{ const npc=getAutoNonPrefCount(me.id); const autoBonus=autoC*(config.involuntaryBonus||0), npBonus=npc*(config.nonPreferredBonus||0); return (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-3 text-sm">
          <span className="font-medium text-blue-900">⚙ {autoC} auto-assigned shift{autoC>1?"s":""}</span>
          <span className="text-blue-700"> (+{autoBonus+npBonus} bonus pts{npc>0?<span className="text-[11px]"> · {autoBonus} auto + {npBonus} non-pref</span>:null})</span>
        </div>
      );})()}
      {/* Provider alert: preferred-day shortfall. Cleaner card frame with prominent header,
          warning glyph, and a red callout for the specifics. Matches the admin Alerts aesthetic. */}
      {!avail.meets&&currentBlock&&(
        <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6 mb-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-100 text-red-700 flex items-center justify-center flex-shrink-0 text-xl leading-none">⚠️</div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-ink-900">Alert: Preferred shift shortfall</h2>
              <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900 space-y-1">
                {avail.dayShort>0&&<div>Need <span className="font-bold tabular-nums">{avail.dayShort}</span> more Top Option{avail.dayShort===1?"":"s"} or preferred day{avail.dayShort===1?"":"s"}.</div>}
                {avail.wkShort>0&&<div>Need <span className="font-bold tabular-nums">{avail.wkShort}</span> more weekend day{avail.wkShort===1?"":"s"}.</div>}
                <div className="pt-1 font-bold">Current penalty: −{avail.penalty} pt{avail.penalty===1?"":"s"}</div>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-5">
        <Stat label="Total pts" value={total.toFixed(total%1?1:0)} color={total<0?"text-red-600":"text-amber-600"}/>
        <Stat label="Shifts" value={`${count}/${min||"—"}`} color="text-blue-600"/>
        <Stat label="Available" value={`${avail.availD}/${blockDays.length||"—"}`} color={avail.meets?"text-green-600":"text-red-600"}/>
      </div>
      {currentBlock&&(()=>{
        const ph = phaseOf(currentBlock);
        const tone = PHASE_TONE[ph];
        return (
          <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3">
            <div className="text-sm font-semibold mb-1">{currentBlock.name||"This block"}</div>
            <p className="text-sm text-slate-600">{MONTHS_SHORT[parseDk(currentBlock.start).getMonth()]} {parseDk(currentBlock.start).getDate()} → {MONTHS_SHORT[parseDk(currentBlock.end).getMonth()]} {parseDk(currentBlock.end).getDate()}</p>
            <div className="mt-2 inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`}></span>
              <span className={`text-xs font-bold uppercase tracking-wider ${tone.text}`}>{PHASE_LABEL[ph]}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{PHASE_DESC[ph]}</p>
          </div>
        );
      })()}
      <div>
        <button onClick={()=>setPage("schedule")} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-medium text-sm">Open schedule →</button>
      </div>
    </>);
  };

  const AdminHome = () => {
    const provs=users.filter(u=>u.role==="provider"), unassigned=provs.filter(u=>!u.seniorityId);
    let assigned=0;
    Object.values(shifts).forEach(d=>Object.values(d).forEach(e=>{
      if(getUid(e)) assigned++;
    }));
    // Days with at least one Top Option (any open slot on those days is "pending pool" until reconcile).
    // Contested = day with 2+ Top-Optioners (more candidates than they can possibly all win).
    let pendingDays=0, contested=0;
    blockDays.forEach(k => {
      const n = dayTopOptionerCount(k);
      if(n > 0){
        pendingDays++;
        if(n > config.shiftSlots.length) contested++;
        else if(n > 1) contested++;  // any contested even if it could fit
      }
    });
    const pendingPool = pendingDays;  // alias kept for downstream UI labels
    const totalSlots=blockDays.length*config.shiftSlots.length, open=totalSlots-assigned;
    const failingAvail=provs.filter(u=>!getAvailInfo(u.id).meets);
    return(<>
      <h1 className="text-2xl font-semibold mb-1">Dashboard</h1>
      <p className="text-sm text-slate-500 mb-3">Block overview.</p>
      {/* Block switcher — when 2+ blocks exist, admin can pick which one these stats + actions apply to. */}
      {(config.blocks||[]).length>0&&(
        <div className="bg-white rounded-xl border border-slate-200 p-3 mb-4 flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-slate-600 flex-shrink-0">Viewing block</label>
          <select value={config.currentBlockId||""} onChange={e=>updateConfig({currentBlockId:e.target.value?parseInt(e.target.value):null})}
            className="flex-1 min-w-[8rem] px-2 py-1.5 border border-slate-300 rounded-md text-sm bg-white">
            {config.blocks.map(b=>{
              const range = b.start&&b.end ? ` (${MONTHS_SHORT[parseDk(b.start).getMonth()]} ${parseDk(b.start).getDate()}–${MONTHS_SHORT[parseDk(b.end).getMonth()]} ${parseDk(b.end).getDate()})` : " (dates unset)";
              return <option key={b.id} value={b.id}>{b.name||"Block"}{range}</option>;
            })}
          </select>
          <button onClick={()=>setPage("setup")} className="text-xs font-medium text-blue-700 hover:text-blue-800 px-2 py-1">Manage →</button>
        </div>
      )}
      {(()=>{ const ph=phaseOf(currentBlock); const tone=PHASE_TONE[ph]; return (
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3 mb-5">
        <Stat label="Providers" value={provs.length} color="text-blue-600"/>
        <Stat label="Awarded" value={totalSlots?`${assigned}/${totalSlots}`:"—"} color={assigned===totalSlots?"text-green-600":"text-amber-600"} small/>
        <Stat label="Top Option dates" value={pendingPool} color={pendingPool>0?"text-blue-600":"text-slate-400"} small/>
        {/* Per the spec, open-shifts-remaining is a first-class dashboard metric. */}
        <Stat label="Open" value={open} color={open===0?"text-green-600":open>0?"text-red-600":"text-slate-400"}/>
        <Stat label="Phase" value={currentBlock?PHASE_LABEL[ph]:"—"} color={currentBlock?tone.text:"text-slate-400"} small/>
      </div>
      ); })()}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Quick actions</div>
          {currentBlock&&(()=>{ const ph=phaseOf(currentBlock); const tone=PHASE_TONE[ph]; return (
            <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] px-2 py-1 rounded-full border ${tone.bg} ${tone.text} ${tone.border}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`}></span>
              {PHASE_LABEL[ph]}
            </span>
          ); })()}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {/* Phase-aware primary action. AVAIL: Close & assign (combined reconcile + auto-fill).
              RECON: Lock block. LOCKED: read-only "locked" pill. */}
          {(()=>{ const ph=phaseOf(currentBlock);
            if(!currentBlock) return (
              <button disabled className="py-2.5 text-sm font-medium rounded-lg bg-slate-200 text-slate-500 cursor-not-allowed">No block selected</button>
            );
            if(ph===PHASE.AVAIL) return (
              <button onClick={()=>setReconcilePreview(computeReconcile())} disabled={totalSlots===0}
                className="py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
                Close &amp; assign{pendingPool>0?` (${pendingPool} Top Option${pendingPool===1?"":"s"})`:""}
              </button>
            );
            if(ph===PHASE.RECON) return (
              <button onClick={()=>setConfirmLock(true)} disabled={!currentBlock}
                className="py-2.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">
                🔒 Lock block
              </button>
            );
            return (
              <button onClick={()=>{ updateCurrentBlock({phase:PHASE.RECON}); trackEvent("block.unlock", { blockId: currentBlock?.id != null ? String(currentBlock.id) : null }); }}
                className="py-2.5 text-sm font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700">
                🔓 Unlock (back to Reconciliation)
              </button>
            );
          })()}
          {/* Secondary action — visible only in AVAIL as a manual auto-fill preview tool. */}
          {phaseOf(currentBlock)===PHASE.AVAIL&&(
            <button onClick={()=>setAutoPreview(computeAutoAssign())} disabled={totalSlots-assigned===0}
              className="py-2.5 text-sm font-medium rounded-lg bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40">
              {totalSlots-assigned===0?"All filled ✓":`Preview auto-fill (${totalSlots-assigned})`}
            </button>
          )}
          <button onClick={()=>setShowBlockReport(true)} disabled={!currentBlock||totalSlots===0}
            className="py-2.5 text-sm border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-40 font-medium">
            📊 Block report
          </button>
          <button onClick={()=>setPage("setup")} className="py-2.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">Setup</button>
          <button onClick={()=>setPage("people")} className="py-2.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">People</button>
        </div>
        {contested>0&&<p className="text-[11px] text-slate-500 mt-2">{contested} contested date{contested===1?"":"s"} (2+ Top-Optioners) — assignment awards to the highest bidder (ties break on current points). Winner pays next-highest bid + 1.</p>}
        {(assigned>0||pendingPool>0)&&(
          <div className="mt-3 pt-3 border-t border-slate-100">
            <button onClick={()=>setConfirmReset(true)} className="w-full py-2 text-xs font-medium rounded-lg border border-red-200 text-red-700 hover:bg-red-50">
              ↺ Reset block
            </button>
            <p className="text-[11px] text-slate-500 mt-1.5">Clears all awards and Top Options for this block and reopens signup. Refunds any winning bids charged in the last assignment. Keeps availability, preferences, and targets.</p>
          </div>
        )}
      </div>
      {/* Alerts module — surfaces blocking issues that need admin attention. Renders only when at least one alert is active. */}
      {(unassigned.length>0||failingAvail.length>0)&&(()=>{
        const issueCount=(unassigned.length>0?1:0)+(failingAvail.length>0?1:0);
        return (
          <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6 mb-3">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base sm:text-lg font-bold text-ink-900">Alerts</h2>
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{issueCount} issue{issueCount===1?"":"s"}</span>
            </div>
            <div className="space-y-2">
              {unassigned.length>0&&(
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start justify-between gap-3">
                  <div className="font-semibold text-amber-900 text-sm">{unassigned.length} need seniority assigned</div>
                  <button onClick={()=>setPage("people")} className="text-xs bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg font-medium flex-shrink-0">Assign →</button>
                </div>
              )}
              {failingAvail.length>0&&(
                <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                  <div className="font-semibold text-red-900 text-sm mb-1">{failingAvail.length} not meeting availability requirements</div>
                  <ul className="text-xs text-red-800 space-y-0.5">{failingAvail.map(u=>{
                    const a=getAvailInfo(u.id);
                    const parts=[];
                    if(!a.prefMeets)parts.push(`pref ${a.pref}/${config.minPreferredDays}`);
                    if(!a.blockMeets)parts.push(`blocks ${a.blocked}/${config.maxBlockedDays}`);
                    return <li key={u.id}>{u.name} — {parts.join(" · ")} · −{a.penalty} pts</li>;
                  })}</ul>
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {/* Flagged shifts module — providers who flagged their assignments. Each card lists ranked
          swap recommendations (preferred + below-max first) with one-click Accept. */}
      {(()=>{
        const flagged = [];
        for(const k of blockDays){
          const day = shifts[k] || {};
          for(const slot of config.shiftSlots){
            const e = day[slot.id];
            if(e && e.confirm === "flagged" && getUid(e)){
              flagged.push({ dateKey: k, slotId: slot.id, slot, entry: e, originalUid: getUid(e) });
            }
          }
        }
        if(!flagged.length) return null;
        return (
          <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6 mb-3">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base sm:text-lg font-bold text-ink-900">⚠ Flagged shifts</h2>
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-red-600">{flagged.length} need{flagged.length===1?"s":""} review</span>
            </div>
            <div className="space-y-3">{flagged.map(({dateKey, slotId, slot, entry, originalUid})=>{
              const date = parseDk(dateKey);
              const original = users.find(u => u.id === originalUid);
              const candidates = findSwapCandidates(dateKey, originalUid).slice(0, 5);
              return (
                <div key={`${dateKey}_${slotId}`} className="bg-red-50/60 border border-red-200 rounded-xl p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-sm text-ink-900">{DAYS_SHORT[date.getDay()]} {MONTHS_SHORT[date.getMonth()]} {date.getDate()}</span>
                        <span className="font-bold text-xs px-2 py-0.5 rounded text-white" style={{background:slot?.color}}>{slot?.name}</span>
                        <span className="text-xs text-slate-700">flagged by <span className="font-semibold">{original?.name||"?"}</span></span>
                      </div>
                      {entry.flagReason && <div className="text-[11px] text-red-700 italic mt-1">"{entry.flagReason}"</div>}
                    </div>
                    <button onClick={()=>clearFlag(dateKey, slotId)}
                      className="text-[11px] font-semibold px-2.5 py-1 border border-slate-300 text-slate-600 rounded-md hover:bg-white whitespace-nowrap">
                      Clear flag
                    </button>
                  </div>
                  {candidates.length === 0
                    ? <div className="bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-600">No eligible swap candidates. The shift is on the marketplace — admin or provider must reassign manually.</div>
                    : <div className="space-y-1">
                        <div className="text-[10px] font-bold text-ink-500 uppercase tracking-wider mb-1">Recommended swaps</div>
                        {candidates.map(c => {
                          const max = c.user.targets?.max || 0;
                          return (
                            <div key={c.user.id} className="bg-white border border-slate-200 rounded-lg p-2.5 flex items-center gap-2.5">
                              <div className="w-9 h-9 rounded-full text-white flex items-center justify-center text-xs font-semibold flex-shrink-0" style={{background:COLORS[c.user.id%COLORS.length]}}>{initials(c.user.name)}</div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium text-ink-900 truncate">{c.user.name}</div>
                                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 mt-0.5">
                                  {c.preferred && <span className="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">⭐ Preferred</span>}
                                  <span>{c.currentCount}{max>0?`/${max}`:""} shifts · {c.snapshotPts} pts</span>
                                </div>
                              </div>
                              <button onClick={()=>acceptSwapCandidate(dateKey, slotId, c.user.id)}
                                className="text-[11px] font-bold px-2.5 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex-shrink-0">
                                Reassign →
                              </button>
                            </div>
                          );
                        })}
                      </div>
                  }
                </div>
              );
            })}</div>
          </div>
        );
      })()}
    </>);
  };

  const ShiftsPage = () => {
    const provs = users.filter(u=>u.role==="provider").sort((a,b)=>a.name.localeCompare(b.name));
    const fu = filterUid?users.find(u=>u.id===filterUid):null;
    let fCount = 0;
    if(filterUid){
      for(const k of blockDays) for(const s of config.shiftSlots) if(getUid(shifts[k]?.[s.id])===filterUid) fCount++;
    }
    return(<>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-2xl font-semibold">{me.role==="admin"?"Calendar":"Pick shifts"}</h1>
        <div className="flex bg-slate-100 rounded-lg p-0.5">
          <button onClick={()=>setShiftsView("list")} className={`px-3 py-1.5 text-xs font-medium rounded-md ${shiftsView==="list"?"bg-white shadow text-slate-900":"text-slate-500"}`}>List</button>
          <button onClick={()=>setShiftsView("cal")} className={`px-3 py-1.5 text-xs font-medium rounded-md ${shiftsView==="cal"?"bg-white shadow text-slate-900":"text-slate-500"}`}>Calendar</button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-3">
        {me.role==="admin"?"Tap any day to assign.":!me.seniorityId?"Admin must assign your seniority.":isAvailabilityOpen(currentBlock)?"Tap a day to sign up.":isReconciling(currentBlock)?"Block is in Reconciliation — view only.":isLocked(currentBlock)?"Block is locked.":"View only."}
      </p>
      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-slate-500 whitespace-nowrap">Show shifts for</label>
        <select value={filterUid||""} onChange={e=>setFilterUid(e.target.value?parseInt(e.target.value):null)} className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white">
          <option value="">Everyone</option>
          {provs.map(u=>(<option key={u.id} value={u.id}>{u.name}{u.id===me.id?" (you)":""}</option>))}
        </select>
        {filterUid&&<button onClick={()=>setFilterUid(null)} className="text-xs text-slate-500 hover:text-slate-900 px-2 py-1">Clear</button>}
      </div>
      {filterUid&&<p className="text-xs text-slate-500 mb-3 px-1">Showing {fCount} awarded shift{fCount===1?"":"s"} for <span className="font-medium text-slate-700">{fu?.name}</span>.</p>}
      <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-5">
        {shiftsView==="list"?ListView():CalendarView()}
      </div>
    </>);
  };

  // Provider-only combined Schedule page: targets + preferences + blocks + pool sign-up in one view.
  // Replaces the old separate Availability + Shifts pages (admins still have the Calendar page).
  // v2 SchedulePage — redesigned with status-report hero, card grid (targets + spacing), daily list/calendar
  const SchedulePage = () => {
    const avail=getAvailInfo(me.id);
    const t=me.targets||{min:0,ideal:0,max:0};
    const want=wantedCount(me.id);
    const sp = me.spacingPref || { mode: "none", maxConsecutive: 3, minGap: 2 };
    const setSp = patch => updateUser(me.id, { spacingPref: {...sp, ...patch} });
    // Status-report extras: total points and # of days they have an active Top Option for.
    const myPoints = totalPts(me.id);
    const myPoolCount = blockDays.filter(k => inTopOption(k, me.id)).length;
    const statusOk = avail.meets;
    // Headline color reflects overall pass/fail
    const statusText = statusOk ? "text-emerald-600" : "text-amber-600";
    return(<>
      {/* Hero */}
      <div className="mb-6 sm:mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-brand-700 leading-tight tracking-tight">Schedule</h1>
        <p className="text-sm sm:text-base text-ink-500 mt-2 max-w-2xl leading-relaxed">
          Mark the days you prefer, block the ones you can't work, and set 🎯 Top Option on the days you're committing to.
          Accurate preferences help auto-assign fill the block fairly.
        </p>
      </div>

      {/* Status Report card — two sub-checks (preferred + blocked) plus running totals */}
      <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6 mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className={`text-[10px] font-bold uppercase tracking-[0.15em] ${statusText}`}>Status report</div>
            <div className={`text-lg sm:text-xl font-bold mt-1 ${statusText}`}>
              {statusOk ? "Meets all requirements" : "Requirements not met"}
            </div>
          </div>
          {avail.penalty>0 && (
            <div className="text-right">
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-700">Penalty</div>
              <div className="text-3xl sm:text-4xl font-extrabold tabular-nums text-amber-700 leading-none mt-0.5">−{avail.penalty}</div>
            </div>
          )}
        </div>
        {/* Two-up status grid */}
        <div className="grid sm:grid-cols-2 gap-3">
          {/* Preferred days check */}
          <div className={`rounded-xl px-4 py-3 border ${avail.prefMeets?"bg-emerald-50/70 border-emerald-200":"bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className={`text-base ${avail.prefMeets?"text-emerald-600":"text-amber-600"}`}>{avail.prefMeets?"✓":"⚠"}</span>
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-700">⭐ Preferred days</span>
            </div>
            <div className="text-xs text-ink-700 leading-relaxed">
              <span className={`font-extrabold tabular-nums ${avail.prefMeets?"text-emerald-700":"text-amber-700"}`}>{avail.pref}</span>
              <span className="text-ink-500"> / </span>
              <span className="font-semibold tabular-nums">{config.minPreferredDays||0}</span> days
              {" · "}
              <span className={`font-extrabold tabular-nums ${avail.prefMeets?"text-emerald-700":"text-amber-700"}`}>{avail.prefWk}</span>
              <span className="text-ink-500"> / </span>
              <span className="font-semibold tabular-nums">{config.minPreferredWeekendDays||0}</span> wknd
            </div>
            {!avail.prefMeets && (
              <div className="text-[11px] text-amber-800 mt-1.5 leading-relaxed">
                {avail.prefShort>0 && <>Need <span className="font-bold">{avail.prefShort}</span> more pref day{avail.prefShort>1?"s":""}. </>}
                {avail.prefWkShort>0 && <>Need <span className="font-bold">{avail.prefWkShort}</span> more pref weekend.</>}
              </div>
            )}
          </div>
          {/* Blocked days check */}
          <div className={`rounded-xl px-4 py-3 border ${avail.blockMeets?"bg-emerald-50/70 border-emerald-200":"bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className={`text-base ${avail.blockMeets?"text-emerald-600":"text-amber-600"}`}>{avail.blockMeets?"✓":"⚠"}</span>
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-700">✕ Blocked days</span>
            </div>
            <div className="text-xs text-ink-700 leading-relaxed">
              <span className={`font-extrabold tabular-nums ${avail.blockMeets?"text-emerald-700":"text-amber-700"}`}>{avail.blocked}</span>
              <span className="text-ink-500"> / </span>
              <span className="font-semibold tabular-nums">{config.maxBlockedDays||0}</span> days
              {" · "}
              <span className={`font-extrabold tabular-nums ${avail.blockMeets?"text-emerald-700":"text-amber-700"}`}>{avail.blockedWk}</span>
              <span className="text-ink-500"> / </span>
              <span className="font-semibold tabular-nums">{config.maxBlockedWeekendDays||0}</span> wknd
            </div>
            {!avail.blockMeets && (
              <div className="text-[11px] text-amber-800 mt-1.5 leading-relaxed">
                {avail.blockOver>0 && <><span className="font-bold">{avail.blockOver}</span> over the day limit. </>}
                {avail.blockWkOver>0 && <><span className="font-bold">{avail.blockWkOver}</span> over the weekend limit.</>}
              </div>
            )}
          </div>
        </div>
        {/* Points + Pool count — quick at-a-glance running totals */}
        <div className="mt-4 pt-4 border-t border-slate-200 grid grid-cols-2 gap-3">
          <div className="bg-slate-50 rounded-xl px-4 py-3 border border-slate-200/70">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-500">Spendable points</div>
            <div className={`text-2xl sm:text-3xl font-extrabold tabular-nums mt-0.5 leading-none ${myPoints<0?"text-red-600":"text-brand-700"}`}>{myPoints.toFixed(1)}</div>
            <div className="text-[10px] text-ink-400 mt-1 leading-tight">Cap on your bids. Shifts you win this block don't credit pts until the block locks.</div>
          </div>
          <div className="bg-slate-50 rounded-xl px-4 py-3 border border-slate-200/70">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-500">Top Option dates</div>
            <div className="flex items-baseline gap-1.5 mt-0.5 leading-none">
              <span className={`text-2xl sm:text-3xl font-extrabold tabular-nums ${myPoolCount>0?"text-blue-600":"text-ink-400"}`}>{myPoolCount}</span>
              <span className="text-xs font-semibold text-ink-500">day{myPoolCount===1?"":"s"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Two cards: Shift Targets + Back-to-back */}
      <div className="grid md:grid-cols-2 gap-4 mb-5">
        {/* Shift Targets */}
        <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-700 flex items-center justify-center font-bold">📊</div>
            <h2 className="text-base sm:text-lg font-bold text-ink-900">Shift targets</h2>
          </div>
          <p className="text-xs sm:text-sm text-ink-500 mb-5 leading-relaxed">
            Set your shift volume targets. Auto-assign aims to land you between min and ideal.
          </p>
          <div className="space-y-5">
            {[
              ["min", "Minimum # of Shifts", "text-brand-700"],
              ["ideal", "Ideal # of Shifts", "text-emerald-600"],
              ["max", "Maximum # Shifts", "text-amber-600"],
            ].map(([k,l,clr])=>{
              const floor = (k==="min" && mySeniority) ? (mySeniority.minShifts||0) : 0;
              const ceiling = Math.max(60, blockDays.length||30);
              const val = Math.max(floor, t[k]||0);
              // Floor enforced inside setVal — providers can RAISE their min above the seniority floor,
              // but never drop below it. The − button greys out at the floor as a visual cue.
              const setVal = v => setTargets(me.id,{...t,[k]:Math.max(floor,Math.min(ceiling,v))});
              return(
                <div key={k}>
                  <div className="flex items-end justify-between mb-2 gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-500">
                      {l}{k==="min"&&floor>0&&<span className="ml-1 text-ink-400 normal-case tracking-normal" title={`Seniority floor = ${floor}`}>floor {floor}</span>}
                    </span>
                    {/* Stepper: typeable number bracketed by − / + buttons */}
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={()=>setVal(val-1)} disabled={val<=floor}
                        aria-label={`Decrease ${l}`}
                        className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-ink-700 flex items-center justify-center font-bold text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed transition">−</button>
                      <input type="number" min={floor} max={ceiling} value={val}
                        onChange={e=>{ const n=parseInt(e.target.value); if(!isNaN(n)) setVal(n); }}
                        className={`v2-num-input w-14 px-1 py-0.5 text-2xl font-extrabold tabular-nums text-center bg-transparent outline-none border border-transparent focus:border-brand-300 focus:bg-white rounded-lg ${clr}`}/>
                      <button type="button" onClick={()=>setVal(val+1)} disabled={val>=ceiling}
                        aria-label={`Increase ${l}`}
                        className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-ink-700 flex items-center justify-center font-bold text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed transition">+</button>
                    </div>
                  </div>
                  <input type="range" min={floor} max={ceiling} value={val}
                    onChange={e=>setVal(parseInt(e.target.value)||0)}
                    className="v2-slider w-full"/>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-ink-500 mt-5 leading-relaxed">
            {mySeniority?<>Min set by seniority (<span className="font-semibold text-ink-700">{mySeniority.name}</span> = {mySeniority.minShifts||0}). You can raise it, but not below this floor.</>:<>An admin will assign your seniority to set your minimum.</>}
          </p>
        </div>

        {/* Back-to-back preference */}
        <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-700 flex items-center justify-center font-bold">🔁</div>
            <h2 className="text-base sm:text-lg font-bold text-ink-900">Back-to-back shifts</h2>
          </div>
          <p className="text-xs sm:text-sm text-ink-500 mb-5 leading-relaxed">
            Should auto-assign cluster your shifts together or spread them out?
          </p>
          <div className="grid grid-cols-3 gap-1.5 mb-3">
            {[["none","No preference"],["consecutive","Clustering Okay"],["spread","Spread Out Shifts"]].map(([v,l])=>(
              <button key={v} onClick={()=>setSp({mode:v})}
                className={`text-[11px] sm:text-xs py-2.5 px-2 rounded-xl font-semibold border transition leading-tight ${sp.mode===v?"bg-brand-700 border-brand-700 text-white shadow-card":"bg-surface border-slate-200 text-ink-700 hover:bg-slate-50"}`}>
                {l}
              </button>
            ))}
          </div>
          {sp.mode==="consecutive"&&(
            <div className="flex items-center gap-2 mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
              <label className="text-xs font-semibold text-ink-700 flex-1">Max consecutive shifts</label>
              <input type="number" min="2" max="14" value={sp.maxConsecutive||3}
                onChange={e=>setSp({maxConsecutive:Math.max(2,Math.min(14,parseInt(e.target.value)||2))})}
                className="w-16 px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-center font-bold bg-surface"/>
            </div>
          )}
          {sp.mode==="spread"&&(
            <div className="flex items-center gap-2 mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
              <label className="text-xs font-semibold text-ink-700 flex-1">Ideal gap between shifts (days)</label>
              <input type="number" min="1" max="14" value={sp.minGap||2}
                onChange={e=>setSp({minGap:Math.max(1,Math.min(14,parseInt(e.target.value)||1))})}
                className="w-16 px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-center font-bold bg-surface"/>
            </div>
          )}
          <div className="mt-5 pt-4 border-t border-slate-200 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-500">Preferred dates</span>
            <span className="text-2xl font-extrabold tabular-nums text-emerald-600">{want}</span>
          </div>
        </div>
      </div>

      {/* Daily preferences */}
      <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-700 flex items-center justify-center font-bold">📅</div>
            <h2 className="text-base sm:text-lg font-bold text-ink-900">Daily preferences</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-ink-500 hidden sm:inline">
              {blockDays.length} day{blockDays.length===1?"":"s"} · phase <span className={`font-semibold ${PHASE_TONE[phaseOf(currentBlock)].text}`}>{PHASE_LABEL[phaseOf(currentBlock)].toLowerCase()}</span>
            </span>
            <div className="flex bg-slate-100 rounded-lg p-0.5">
              {[["list","List"],["calendar","Calendar"]].map(([v,l])=>(
                <button key={v} onClick={()=>setAvailView(v)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition ${availView===v?"bg-surface shadow-card text-ink-900":"text-ink-500 hover:text-ink-700"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
        {!blockDays.length
          ? <p className="text-sm text-ink-500 text-center py-10">No block dates set yet — an admin will configure the block.</p>
          : availView==="list" ? ScheduleList() : CalendarView()}
      </div>
    </>);
  };

  // v3 ScheduleList — date tile + slot chips + 3-state segmented control (Pref/Avail/Blocked).
  // In Reconciliation+ the personal pref/blocked overlays drop and the buttons disappear, so the
  // user reads the canonical assigned schedule instead of their own input layer.
  // v3.1 ScheduleList — single 4-state segmented control per day (Top Option / Preferred / Available / Blocked).
  // Top Option expands inline with slot pref + bid stepper. In Reconciliation+ the control hides
  // and the user just reads the assigned schedule.
  const ScheduleList = () => (
    <div className="space-y-3">{blockDays.map(k=>{
      const date=parseDk(k);
      const availPhase = isAvailabilityOpen(currentBlock);
      const blockedRaw=isUnavail(me.id,k), wantedRaw=isWanted(me.id,k);
      const reason=unavailReason(me.id,k);
      const blocked = availPhase && blockedRaw;
      const wanted = availPhase && wantedRaw;
      const meTopOpt = availPhase && inTopOption(k, me.id);
      const dayS=shifts[k]||{}, hasShift=Object.values(dayS).some(e=>getUid(e)===me.id);
      const isWk=isWeekend(k), pts=dayPts(date,config), hol=config.holidays[k];
      const filled=Object.values(dayS).filter(e=>getUid(e)).length, total=config.shiftSlots.length;
      const dayTopCount = dayTopOptionerCount(k);
      // 4-state setters. Each clears the others and lands on the requested state.
      const goTop = async () => {
        if(blockedRaw) await toggleUnavail(k);
        await setTopOption(k, getDaySlotPref(k, me.id), inTopOption(k, me.id) ? topOptions[k][me.id].bid : TOP_OPTION_DEFAULT_BID);
      };
      const goPreferred = async () => {
        if(meTopOpt) await clearTopOption(k);
        if(blockedRaw) await toggleUnavail(k);
        if(!wantedRaw) await togglePreference(k);
      };
      const goAvailable = async () => {
        if(meTopOpt) await clearTopOption(k);
        if(blockedRaw) await toggleUnavail(k);
        if(wantedRaw) await togglePreference(k);
      };
      const goBlocked = async () => {
        if(hasShift && !blockedRaw) return;
        if(meTopOpt) await clearTopOption(k);
        if(wantedRaw) await togglePreference(k);
        if(!blockedRaw) await toggleUnavail(k);
      };
      // Point pill — deeper amber as pts climb; brand-blue for 1pt weekdays; neutral for 0-pt.
      const pillBg = pts===0?"bg-slate-100 text-ink-500":pts===1?"bg-brand-50 text-brand-700":pts===2?"bg-amber-100 text-amber-800":pts===3?"bg-amber-200 text-amber-900":"bg-amber-300 text-amber-900";
      const cardFrame = blocked
        ? "bg-red-50/60 border-red-200"
        : hasShift
          ? "bg-surface ring-2 ring-emerald-400 border-transparent"
          : meTopOpt
            ? "bg-blue-50/50 border-blue-200"
            : wanted
              ? "bg-emerald-50/40 border-emerald-200"
              : "bg-surface border-slate-200";
      const tileBg = blocked?"bg-red-100":meTopOpt?"bg-blue-100":wanted?"bg-emerald-100":hasShift?"bg-emerald-50":"bg-slate-50";
      const tileText = blocked?"text-red-700":meTopOpt?"text-blue-700":wanted?"text-emerald-700":"text-ink-900";
      const tileDow = blocked?"text-red-600":meTopOpt?"text-blue-700":wanted?"text-emerald-700":"text-ink-500";
      return(
        <div key={k} className={`rounded-2xl border shadow-card overflow-hidden ${cardFrame}`}>
          <button onClick={()=>setEditingDay(k)} className="w-full flex items-center gap-3 sm:gap-4 p-4 text-left hover:bg-slate-50/40 transition">
            {/* Date tile */}
            <div className={`w-14 h-14 rounded-xl flex flex-col items-center justify-center flex-shrink-0 ${tileBg}`}>
              <div className={`text-[9px] font-bold uppercase tracking-widest leading-none ${tileDow}`}>{DAYS_SHORT[date.getDay()]}</div>
              <div className={`text-xl font-extrabold leading-tight mt-1 tabular-nums ${tileText}`}>{String(date.getDate()).padStart(2,"0")}</div>
            </div>
            {/* Middle — title + meta chips + slot chips */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                <span className="font-semibold text-sm text-ink-900">{MONTHS_SHORT[date.getMonth()]} {date.getDate()}</span>
                {meTopOpt && <span className="text-blue-600 text-sm leading-none" title="Top Option">🎯</span>}
                {wanted && !meTopOpt && <span className="text-emerald-500 text-sm leading-none" title="Preferred">⭐</span>}
                {pts>0 && <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${pillBg}`}>+{pts} pt{pts>1?"s":""}</span>}
                {isWk && <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-medium">Weekend</span>}
                {hol && <span className="text-[10px] bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-full font-medium">{hol}</span>}
                {blocked && <span className="text-[10px] bg-red-100 text-red-800 border border-red-200 px-2 py-0.5 rounded-full font-bold">✕ Blocked{reason?` · ${reason}`:""}</span>}
                {hasShift && <span className="text-[10px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded-full font-bold">✓ You're on</span>}
                {availPhase && dayTopCount>0 && !meTopOpt && !hasShift && (
                  <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-semibold">🎯 {dayTopCount} Top Option{dayTopCount===1?"":"s"}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {config.shiftSlots.map(s=>{
                  const entry=dayS[s.id], winUid=getUid(entry), u=winUid?users.find(x=>x.id===winUid):null;
                  const isMe=winUid===me.id, auto=isAuto(entry);
                  if(u) return(
                    <span key={s.id} className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${isMe?"bg-emerald-100 text-emerald-800":"text-white"}`}
                      style={!isMe?{background:s.color}:{}}>
                      {s.name}: {isMe?"You":u.name.split(" ")[0]}{auto?" ⚙":""}
                    </span>
                  );
                  return <span key={s.id} className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-white border-2"
                    style={{borderColor:s.color, color:s.color}}>
                    {s.name}: Open
                  </span>;
                })}
              </div>
            </div>
            {/* Right — slot counter */}
            <div className="flex flex-col items-end gap-0 flex-shrink-0">
              <div className={`text-base font-extrabold tabular-nums leading-none ${filled===total?"text-ink-400":filled===0?"text-brand-700":"text-amber-600"}`}>{filled}<span className="text-ink-400">/{total}</span></div>
              <div className="text-[9px] font-bold text-ink-400 uppercase tracking-widest mt-1">slots</div>
            </div>
          </button>
          {/* 4-state segmented control — only mounted during Availability.
                Top Option | Preferred | Available | Blocked
              Top Option expands an inline panel with slot pref + bid stepper.
              In Reconciliation+ this disappears and the user reads the canonical assigned schedule. */}
          {availPhase && (
          <div className="px-4 pb-4 space-y-2">
            <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
              <button onClick={goTop} disabled={hasShift}
                className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${meTopOpt?"bg-blue-600 text-white shadow-sm":"text-ink-500 hover:text-blue-700"} ${hasShift?"opacity-40 cursor-not-allowed":""}`}>
                🎯 Top Option
              </button>
              <button onClick={goPreferred} disabled={hasShift}
                className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${wanted && !meTopOpt?"bg-emerald-500 text-white shadow-sm":"text-ink-500 hover:text-emerald-700"} ${hasShift?"opacity-40 cursor-not-allowed":""}`}>
                ⭐ Preferred
              </button>
              <button onClick={goAvailable}
                className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${!blocked && !wanted && !meTopOpt?"bg-slate-700 text-white shadow-sm":"text-ink-500 hover:text-ink-900"}`}>
                Available
              </button>
              <button onClick={goBlocked} disabled={hasShift && !blocked}
                className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${blocked?"bg-red-500 text-white shadow-sm":"text-ink-500 hover:text-red-600"} ${hasShift && !blocked?"opacity-40 cursor-not-allowed":""}`}>
                ✕ Blocked
              </button>
            </div>
            {/* Top Option detail panel — slot pref + bid */}
            {meTopOpt && (()=>{
              const cur = topOptions[k][me.id];
              const myBid = cur.bid;
              const slotPref = cur.slotPref;
              const cap = Math.max(0, Math.floor(totalPts(me.id)));
              return (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-2.5">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700 mb-1.5">Slot preference</div>
                    <div className="flex gap-1 bg-white rounded-lg p-1 border border-blue-200">
                      {config.shiftSlots.map(s=>(
                        <button key={s.id} type="button" onClick={()=>setSlotPref(k, s.id)}
                          className={`flex-1 text-[11px] font-bold py-1.5 px-2 rounded-md transition ${slotPref===s.id?"text-white shadow-sm":"text-ink-700 hover:bg-blue-50"}`}
                          style={slotPref===s.id?{background:s.color}:{}}>
                          {s.name}
                        </button>
                      ))}
                      <button type="button" onClick={()=>setSlotPref(k, null)}
                        className={`flex-1 text-[11px] font-bold py-1.5 px-2 rounded-md transition ${slotPref==null?"bg-slate-700 text-white shadow-sm":"text-ink-700 hover:bg-slate-100"}`}>
                        Either
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700">Bid</div>
                      <div className="text-[10px] text-ink-500 mt-0.5">Cost if you win · max <span className="font-bold tabular-nums">{cap}</span> pt{cap===1?"":"s"}</div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button type="button" onClick={()=>setBid(k, myBid-1)} disabled={myBid<=0}
                        className="w-7 h-7 rounded-lg bg-white border border-blue-200 hover:bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-base disabled:opacity-30">−</button>
                      <input type="number" min="0" max={cap} value={myBid}
                        onChange={e=>{ const n=parseInt(e.target.value); if(!isNaN(n)) setBid(k, n); }}
                        className="v2-num-input w-14 px-1 py-0.5 text-2xl font-extrabold tabular-nums text-center bg-white outline-none border border-blue-200 focus:border-blue-400 rounded-lg text-blue-700"/>
                      <button type="button" onClick={()=>setBid(k, myBid+1)} disabled={myBid>=cap}
                        className="w-7 h-7 rounded-lg bg-white border border-blue-200 hover:bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-base disabled:opacity-30">+</button>
                    </div>
                  </div>
                  {dayTopCount > 1 && (
                    <div className="text-[11px] text-blue-900 italic">
                      {dayTopCount-1} other provider{dayTopCount===2?"":"s"} also Top-Optioned this day.
                    </div>
                  )}
                </div>
              );
            })()}
            {blocked && (
              <div className="flex items-center gap-2">
                <label className="text-[10px] font-bold text-ink-500 uppercase tracking-wider whitespace-nowrap">Reason</label>
                <select value={reason||""} onChange={e=>setUnavailReason(k,e.target.value)}
                  className="flex-1 text-xs px-3 py-1.5 border border-slate-200 bg-white rounded-lg font-medium">
                  <option value="">— optional —</option>
                  {UNAVAIL_REASONS.map(r=><option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            )}
          </div>
          )}
        </div>
      );
    })}</div>
  );

  const MyShiftsPage = () => {
    const mine=[], pending=[];
    // Awarded shifts (any phase): walk shifts entries.
    Object.entries(shifts).sort().forEach(([k,day])=>{
      Object.entries(day).forEach(([sid,e])=>{
        const slot=config.shiftSlots.find(s=>s.id===parseInt(sid)), date=parseDk(k);
        if(getUid(e)===me.id){
          const pts=dayPts(date,config)*(slot?.credit||1);
          const nonPref=isAuto(e)&&!(preferences[me.id]||[]).includes(k);
          mine.push({k,date,slot,pts,auto:isAuto(e),nonPref,sid:parseInt(sid),entry:e});
        }
      });
    });
    // Pending: days I have an active Top Option for. Slot is undefined (slotPref expressed
    // separately, may be Either). Surface them so the user can see what they've committed to.
    blockDays.forEach(k => {
      if(!inTopOption(k, me.id)) return;
      // If the user has already been awarded a slot today (e.g. their Top Option won), skip.
      const dayS = shifts[k] || {};
      if(Object.values(dayS).some(e => getUid(e) === me.id)) return;
      const info = topOptions[k][me.id];
      const date = parseDk(k);
      const slotPref = info.slotPref != null ? config.shiftSlots.find(s => s.id === info.slotPref) : null;
      pending.push({ k, date, slot: slotPref, bid: info.bid, pSize: dayTopOptionerCount(k) });
    });
    pending.sort((a,b)=>a.k.localeCompare(b.k));
    const phase = phaseOf(currentBlock);
    const reconOrLater = phase===PHASE.RECON || phase===PHASE.LOCKED;
    // Open marketplace listings indexed by `${dateKey}_${slotId}` for quick lookup.
    const openListings = {};
    marketplace.filter(l=>l.status==="open").forEach(l => {
      openListings[`${l.dateKey}_${l.slotId}`] = l;
    });
    const flaggedCount = mine.filter(m => m.entry?.confirm === "flagged").length;
    const confirmedCount = mine.filter(m => m.entry?.confirm === "ok").length;
    const unreviewedCount = reconOrLater ? mine.filter(m => !m.entry?.confirm).length : 0;
    return(<>
      <h1 className="text-2xl font-semibold mb-1">My shifts</h1>
      <p className="text-sm text-slate-500 mb-2">{mine.length} awarded · {pending.length} Top Option{pending.length===1?"":"s"} pending · {getPtsEarned(me.id).toFixed(1)} pts pending (credit when block locks)</p>
      {/* Phase-specific summary banner */}
      {reconOrLater && mine.length>0 && (
        <div className={`mb-4 rounded-xl border p-3 text-sm ${unreviewedCount>0?"bg-amber-50 border-amber-200 text-amber-900":"bg-emerald-50 border-emerald-200 text-emerald-900"}`}>
          <span className="font-bold">{PHASE_LABEL[phase]}.</span>{" "}
          {unreviewedCount>0
            ? <>Please review each shift below — confirm if it works, flag if it doesn't.</>
            : <>All your shifts are reviewed ({confirmedCount} confirmed{flaggedCount>0?`, ${flaggedCount} flagged`:""}).</>}
        </div>
      )}
      {pending.length>0&&(
        <div className="mb-4">
          <div className="text-xs font-medium text-slate-500 mb-2 px-1">PENDING (Top Option)</div>
          <div className="space-y-2">{pending.map((m,i)=>{
            const others=m.pSize-1;
            return(
              <button key={`p${i}`} onClick={()=>setEditingDay(m.k)} className="w-full bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-center gap-3 active:bg-blue-100 text-left">
                <div className="w-12 h-12 rounded-lg bg-white flex flex-col items-center justify-center">
                  <div className="text-[10px] font-bold text-blue-600">{DAYS_SHORT[m.date.getDay()]}</div>
                  <div className="text-lg font-bold text-blue-700">{m.date.getDate()}</div>
                </div>
                <div className="flex-1">
                  <div className="font-medium text-sm">{MONTHS_SHORT[m.date.getMonth()]} {m.date.getDate()}, {m.date.getFullYear()}</div>
                  <div className="flex items-center gap-1.5 text-xs">
                    {m.slot
                      ? <span className="font-medium" style={{color:m.slot.color}}>{m.slot.name} preferred</span>
                      : <span className="text-slate-500 italic">Either slot</span>
                    }
                    <span className="text-slate-500">· bid {m.bid}</span>
                    <span className="text-slate-500">· {others===0?"only you":`you + ${others} other${others===1?"":"s"}`}</span>
                  </div>
                </div>
                <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full font-medium">🎯 Top Option</span>
              </button>
            );
          })}</div>
        </div>
      )}
      {mine.length>0&&pending.length>0&&<div className="text-xs font-medium text-slate-500 mb-2 px-1">AWARDED</div>}
      {!mine.length&&!pending.length?
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center"><div className="text-3xl mb-2">📅</div><p className="text-sm text-slate-500">No shifts yet. Set a 🎯 Top Option on the Schedule page.</p></div>
        :mine.length>0?<div className="space-y-2">{mine.map((m,i)=>{
          const conf = m.entry?.confirm;
          const flagged = conf === "flagged";
          const confirmed = conf === "ok";
          const listing = openListings[`${m.k}_${m.sid}`];
          const earnedPts = (m.pts + (m.auto?(config.involuntaryBonus||0):0) + (m.nonPref?(config.nonPreferredBonus||0):0));
          // Frame color reflects confirm state in Recon+, neutral in Avail.
          const frame = !reconOrLater
            ? "bg-white border-slate-200"
            : flagged ? "bg-red-50/60 border-red-200"
            : confirmed ? "bg-emerald-50/40 border-emerald-200"
            : listing ? "bg-amber-50/60 border-amber-200"
            : "bg-amber-50/30 border-amber-200";
          return (
            <div key={i} className={`rounded-xl border ${frame} overflow-hidden`}>
              <button onClick={()=>setEditingDay(m.k)} className="w-full p-3 flex items-center gap-3 hover:bg-slate-50/40 text-left">
                <div className="w-12 h-12 rounded-lg bg-white border border-slate-100 flex flex-col items-center justify-center flex-shrink-0">
                  <div className="text-[10px] font-bold text-slate-500">{DAYS_SHORT[m.date.getDay()]}</div>
                  <div className="text-lg font-bold">{m.date.getDate()}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{MONTHS_SHORT[m.date.getMonth()]} {m.date.getDate()}, {m.date.getFullYear()}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs mt-0.5">
                    <span className="font-medium" style={{color:m.slot?.color}}>{m.slot?.name}</span>
                    {m.auto&&<span className="bg-blue-100 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 rounded">Auto +{(config.involuntaryBonus||0)+(m.nonPref?(config.nonPreferredBonus||0):0)}</span>}
                    {confirmed && <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-1.5 py-0.5 rounded">✓ Confirmed</span>}
                    {flagged && <span className="bg-red-100 text-red-800 text-[10px] font-bold px-1.5 py-0.5 rounded">⚠ Flagged</span>}
                    {listing && <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-1.5 py-0.5 rounded">📣 Listed{listing.incentivePts>0?` · +${listing.incentivePts}`:""}</span>}
                  </div>
                  {(flagged||listing?.flagReason||m.entry?.flagReason)&&(()=>{
                    const r = listing?.flagReason || m.entry?.flagReason;
                    return r ? <div className="text-[11px] text-red-700 italic mt-1 truncate">"{r}"</div> : null;
                  })()}
                </div>
                <span className="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full font-medium flex-shrink-0">+{earnedPts.toFixed(m.pts%1?2:0)}</span>
              </button>
              {/* Action row — only in Recon+ phases. Three buttons styled like the segmented control on the Schedule list. */}
              {reconOrLater && (
                <div className="px-3 pb-3 flex gap-1 bg-slate-100/60">
                  <button onClick={()=>setShiftConfirm(m.k, m.sid, confirmed?null:"ok")}
                    className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${confirmed?"bg-emerald-500 text-white shadow-sm":"bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}>
                    {confirmed?"✓ Confirmed":"✓ Confirm"}
                  </button>
                  <button onClick={()=>setFlagDraft({dateKey:m.k, slotId:m.sid})} disabled={flagged}
                    className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${flagged?"bg-red-100 text-red-700 cursor-not-allowed":"bg-white border border-red-200 text-red-700 hover:bg-red-50"}`}>
                    {flagged?"⚠ Flagged":"⚠ Flag issue"}
                  </button>
                  <button onClick={()=>listing?cancelListing(listing.id):setListDraft({dateKey:m.k, slotId:m.sid, incentivePts:0})}
                    className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${listing?"bg-amber-500 text-white shadow-sm hover:bg-amber-600":"bg-white border border-amber-200 text-amber-700 hover:bg-amber-50"}`}>
                    {listing?"📣 Cancel listing":"📣 Post for take"}
                  </button>
                </div>
              )}
            </div>
          );
        })}</div>:null
      }
    </>);
  };

  // Trade marketplace — listings posted by providers (or auto-posted by flag with no swap).
  // Anyone eligible can take an open listing; sellers/admins can cancel.
  const MarketplacePage = () => {
    const open = marketplace.filter(l => l.status === "open").sort((a,b) => a.dateKey.localeCompare(b.dateKey));
    const myOpen = open.filter(l => l.sellerId === me.id);
    const otherOpen = open.filter(l => l.sellerId !== me.id);
    const recentDone = marketplace.filter(l => l.status !== "open").sort((a,b) => (b.takenAt||0) - (a.takenAt||0)).slice(0, 8);
    // Eligibility precheck for "Take" button — purely cosmetic disable; takeListing also re-checks.
    const canTake = (l) => {
      if(me.role !== "provider") return { ok:false, why:"Admin can't take shifts" };
      if(l.sellerId === me.id) return { ok:false, why:"This is yours" };
      if(!me.seniorityId) return { ok:false, why:"No seniority assigned" };
      if(isUnavail(me.id, l.dateKey)) return { ok:false, why:"You blocked this day" };
      if(Object.values(shifts[l.dateKey]||{}).some(e => getUid(e) === me.id)) return { ok:false, why:"Already on this day" };
      let myCount = 0;
      Object.values(shifts).forEach(day => Object.values(day).forEach(e => { if(getUid(e) === me.id) myCount++; }));
      const myMax = me.targets?.max || 0;
      if(myMax > 0 && myCount >= myMax) return { ok:false, why:`At max (${myMax})` };
      return { ok:true };
    };
    // Eligibility for offering a trade — viewer must own at least one OTHER awarded shift in the
    // block, must be a provider, and must satisfy the cross-swap constraints (the listing seller
    // would also need to validly hold one of the viewer's shifts; we check that minimally here
    // and trust the per-shift modal + offerTrade reducer to enforce the rest).
    const canOffer = (l) => {
      if(me.role !== "provider") return { ok:false, why:"Admin can't offer trades" };
      if(l.sellerId === me.id) return { ok:false, why:"This is yours" };
      if(!me.seniorityId) return { ok:false, why:"No seniority assigned" };
      if(isUnavail(me.id, l.dateKey)) return { ok:false, why:"You blocked this day" };
      if(Object.values(shifts[l.dateKey]||{}).some(e => getUid(e) === me.id)) return { ok:false, why:"Already on this day" };
      // At least one tradeable shift the user owns (not on the listing's date).
      let hasTradeableShift = false;
      Object.entries(shifts).forEach(([k, day]) => {
        if(!inBlock(k, config) || k === l.dateKey || hasTradeableShift) return;
        Object.values(day).forEach(e => { if(getUid(e) === me.id) hasTradeableShift = true; });
      });
      if(!hasTradeableShift) return { ok:false, why:"No shift to offer" };
      return { ok:true };
    };
    const renderListing = (l) => {
      const slot = config.shiftSlots.find(s => s.id === l.slotId);
      const date = parseDk(l.dateKey);
      const seller = users.find(u => u.id === l.sellerId);
      const mine = l.sellerId === me.id;
      const elig = !mine ? canTake(l) : null;
      const offerElig = !mine ? canOffer(l) : null;
      const pendingOffers = (l.tradeOffers||[]).filter(o => o.status === "pending");
      // Has the viewer already offered on this listing?
      const myPendingOffer = !mine ? pendingOffers.find(o => o.offererId === me.id) : null;
      return (
        <div key={l.id} className="bg-surface rounded-xl border border-slate-200 overflow-hidden">
          <div className="p-3 flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-slate-50 flex flex-col items-center justify-center flex-shrink-0">
              <div className="text-[10px] font-bold text-slate-500">{DAYS_SHORT[date.getDay()]}</div>
              <div className="text-lg font-bold">{date.getDate()}</div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                <span className="font-medium text-sm">{MONTHS_SHORT[date.getMonth()]} {date.getDate()}</span>
                <span className="font-bold text-xs px-2 py-0.5 rounded text-white" style={{background:slot?.color}}>{slot?.name}</span>
                {l.incentivePts>0 && <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full font-bold">+{l.incentivePts} pt incentive</span>}
                {l.autoPosted && <span className="text-[10px] bg-red-50 text-red-700 px-1.5 py-0.5 rounded-full font-medium border border-red-200">flagged</span>}
                {pendingOffers.length>0 && <span className="text-[10px] bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded-full font-bold">🔁 {pendingOffers.length} offer{pendingOffers.length===1?"":"s"}</span>}
              </div>
              <div className="text-xs text-slate-500">From {seller?.name || "?"}{mine?" (you)":""}</div>
              {l.flagReason && <div className="text-[11px] text-red-700 italic mt-0.5 truncate">"{l.flagReason}"</div>}
            </div>
            {mine
              ? <button onClick={()=>cancelListing(l.id)} className="text-xs font-semibold px-3 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50">Cancel</button>
              : <div className="flex flex-col gap-1.5">
                  <button onClick={()=>takeListing(l.id)} disabled={!elig?.ok}
                    title={elig?.why || ""}
                    className="text-xs font-bold px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed whitespace-nowrap">
                    {elig?.ok ? "Take" : (elig?.why||"Can't take")}
                  </button>
                  {myPendingOffer
                    ? <button onClick={()=>declineTradeOffer(l.id, myPendingOffer.id)}
                        className="text-xs font-semibold px-3 py-1.5 border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 whitespace-nowrap">
                        Withdraw offer
                      </button>
                    : <button onClick={()=>setTradeDraft({listingId:l.id, offererDateKey:null, offererSlotId:null, incentivePts:0})}
                        disabled={!offerElig?.ok}
                        title={offerElig?.why || ""}
                        className="text-xs font-bold px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed whitespace-nowrap">
                        🔁 Offer trade
                      </button>
                  }
                </div>
            }
          </div>
          {/* Pending offers — owner sees Accept/Decline; offerer sees their own offer with Withdraw. */}
          {pendingOffers.length>0 && (mine || myPendingOffer) && (
            <div className="border-t border-slate-100 bg-slate-50/60 p-3 space-y-1.5">
              <div className="text-[10px] font-bold text-ink-500 uppercase tracking-wider">Pending offers</div>
              {pendingOffers.map(o => {
                const offerer = users.find(u => u.id === o.offererId);
                const oSlot = config.shiftSlots.find(s => s.id === o.offererSlotId);
                const oDate = parseDk(o.offererDateKey);
                const isMyOffer = o.offererId === me.id;
                if(!mine && !isMyOffer) return null; // hide other people's offers from non-owner
                return (
                  <div key={o.id} className="bg-white border border-slate-200 rounded-lg p-2.5 flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-full text-white flex items-center justify-center text-xs font-semibold flex-shrink-0" style={{background:COLORS[(o.offererId)%COLORS.length]}}>{initials(offerer?.name||"?")}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-ink-900">
                        {offerer?.name||"?"} {isMyOffer?"(you) ":""}offers their{" "}
                        <span className="font-semibold" style={{color:oSlot?.color}}>{MONTHS_SHORT[oDate.getMonth()]} {oDate.getDate()} {oSlot?.name}</span>
                      </div>
                      {o.incentivePts>0 && <div className="text-[10px] text-amber-700 font-semibold mt-0.5">+ {o.incentivePts} pt sweetener to you</div>}
                    </div>
                    {mine
                      ? <div className="flex gap-1 flex-shrink-0">
                          <button onClick={()=>acceptTradeOffer(l.id, o.id)} className="text-[11px] font-bold px-2.5 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700">Accept</button>
                          <button onClick={()=>declineTradeOffer(l.id, o.id)} className="text-[11px] font-semibold px-2.5 py-1.5 border border-slate-300 text-slate-600 rounded-md hover:bg-slate-50">Decline</button>
                        </div>
                      : <button onClick={()=>declineTradeOffer(l.id, o.id)} className="text-[11px] font-semibold px-2.5 py-1.5 border border-slate-300 text-slate-600 rounded-md hover:bg-slate-50 flex-shrink-0">Withdraw</button>
                    }
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    };
    return(<>
      <h1 className="text-2xl font-semibold mb-1">Trades</h1>
      <p className="text-sm text-slate-500 mb-4">
        Open listings · {open.length} active.
        {phaseOf(currentBlock)===PHASE.AVAIL && <span className="block text-amber-700 mt-1">Trades open once the block enters Reconciliation.</span>}
      </p>
      {open.length===0
        ? <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <div className="text-3xl mb-2">🔄</div>
            <p className="text-sm text-slate-500">No open listings right now.</p>
          </div>
        : (<>
            {myOpen.length>0 && (<div className="mb-4">
              <div className="text-xs font-medium text-slate-500 mb-2 px-1">YOUR LISTINGS ({myOpen.length})</div>
              <div className="space-y-2">{myOpen.map(renderListing)}</div>
            </div>)}
            {otherOpen.length>0 && (<div className="mb-4">
              <div className="text-xs font-medium text-slate-500 mb-2 px-1">AVAILABLE TO TAKE ({otherOpen.length})</div>
              <div className="space-y-2">{otherOpen.map(renderListing)}</div>
            </div>)}
          </>)
      }
      {recentDone.length>0 && (
        <div className="mt-6">
          <div className="text-xs font-medium text-slate-500 mb-2 px-1">RECENT ACTIVITY</div>
          <div className="space-y-1">{recentDone.map(l => {
            const slot = config.shiftSlots.find(s => s.id === l.slotId);
            const date = parseDk(l.dateKey);
            const seller = users.find(u => u.id === l.sellerId);
            const taker = l.takenBy ? users.find(u => u.id === l.takenBy) : null;
            return (
              <div key={l.id} className="text-xs text-slate-600 flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-lg">
                <span className="text-slate-400 w-16 flex-shrink-0">{MONTHS_SHORT[date.getMonth()]} {date.getDate()}</span>
                <span className="font-medium" style={{color:slot?.color}}>{slot?.name}</span>
                <span className="text-slate-400">·</span>
                {l.status === "taken"
                  ? <span><span className="font-medium">{seller?.name?.split(" ")[0]||"?"}</span> → <span className="font-medium">{taker?.name?.split(" ")[0]||"?"}</span>{l.incentivePts>0?<span className="text-amber-700"> · {l.incentivePts}pt</span>:""}</span>
                  : <span className="text-slate-500 italic">cancelled by {seller?.name?.split(" ")[0]||"?"}</span>
                }
              </div>
            );
          })}</div>
        </div>
      )}
    </>);
  };

  const StandingsPage = () => (<>
    <h1 className="text-2xl font-semibold mb-1">Standings</h1>
    <p className="text-sm text-slate-500 mb-4">Higher spendable points = bid ceiling and tiebreak priority. Projected pts credit when the block locks.</p>
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {[...users].filter(u=>u.role==="provider")
        .map(u=>({...u,total:totalPts(u.id),earned:getPtsEarned(u.id),penalty:getAvailInfo(u.id).penalty}))
        .sort((a,b)=>b.total-a.total)
        .map((u,i)=>{
          const lvl=config.seniorityLevels.find(l=>l.id===u.seniorityId);
          return(
            <div key={u.id} className={`flex items-center gap-3 p-3 border-b border-slate-100 last:border-0 ${u.id===me.id?"bg-blue-50":""}`}>
              <div className="w-7 text-center text-sm font-bold text-slate-400">#{i+1}</div>
              <div className="w-9 h-9 rounded-full text-white flex items-center justify-center text-xs font-semibold flex-shrink-0" style={{background:COLORS[u.id%COLORS.length]}}>{initials(u.name)}</div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{u.name}{u.id===me.id?" (you)":""}</div>
                <div className="text-xs text-slate-500">{lvl?.name||"Unassigned"}</div>
              </div>
              <div className="text-right">
                <div className={`font-bold ${u.total<0?"text-red-600":"text-amber-600"}`}>{u.total.toFixed(1)}</div>
                <div className="text-[10px] text-slate-400">{u.points} bank{u.penalty>0?` − ${u.penalty}`:""}{u.earned>0?` · +${u.earned.toFixed(1)} pending`:""}</div>
              </div>
            </div>
          );
        })}
    </div>
  </>);

  // v3 SetupPage — modular card windows matching SchedulePage aesthetic.
  // Each settings group lives in its own bg-surface rounded-2xl shadow-card panel with
  // an icon tile + bold heading + brief description. Top Action card surfaces the phase-aware CTA.
  const SetupPage = () => {
    const holidayList = Object.entries(config.holidays);
    // Top action state — phase-aware. AVAIL: Close & assign. RECON: Lock. LOCKED: Unlock.
    const canAct = !!currentBlock && !!currentBlock.start && !!currentBlock.end;
    const phase = phaseOf(currentBlock);
    const tone = PHASE_TONE[phase];
    const actionLabel = !currentBlock
      ? "Create a block first"
      : !currentBlock.start || !currentBlock.end
        ? "Set block start + end dates"
        : phase===PHASE.AVAIL
          ? `Close & assign ${currentBlock.name||"block"}`
          : phase===PHASE.RECON
            ? `Lock ${currentBlock.name||"block"}`
            : `Unlock ${currentBlock.name||"block"} (back to Reconciliation)`;
    const actionBtn = phase===PHASE.AVAIL
      ? "bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white"
      : phase===PHASE.RECON
        ? "bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white"
        : "bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white";
    const onAction = () => {
      if(!canAct) return;
      if(phase===PHASE.AVAIL) setReconcilePreview(computeReconcile());
      else if(phase===PHASE.RECON) setConfirmLock(true);
      else updateCurrentBlock({phase:PHASE.RECON});
    };
    const statusLabel = !currentBlock
      ? "No current block"
      : !currentBlock.start || !currentBlock.end
        ? "Dates missing"
        : PHASE_LABEL[phase];
    return(<>
      {/* Hero */}
      <div className="mb-6 sm:mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-brand-700 leading-tight tracking-tight">Setup</h1>
        <p className="text-sm sm:text-base text-ink-500 mt-2 max-w-2xl leading-relaxed">
          Configure the scheduling block — dates, shift slots, points, and fairness rules.
          Each section below controls one part of the pipeline.
        </p>
      </div>

      {/* Action / Status card — prominent CTA at top, like Schedule's Status Report */}
      <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6 mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className={`text-[10px] font-bold uppercase tracking-[0.15em] ${currentBlock?tone.text:"text-ink-500"}`}>Current block</div>
            <div className="text-lg sm:text-xl font-bold mt-1 text-ink-900 truncate">
              {currentBlock?.name || "None selected"}
            </div>
            {currentBlock?.start&&currentBlock?.end&&(
              <div className="text-xs text-ink-500 mt-1 tabular-nums">
                {currentBlock.start} → {currentBlock.end}
              </div>
            )}
          </div>
          <div className={`text-sm font-bold px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 ${currentBlock?`${tone.bg} ${tone.text}`:"bg-slate-100 text-ink-500"}`}>
            {currentBlock&&<span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`}></span>}
            {statusLabel}
          </div>
        </div>
        <button onClick={onAction}
          disabled={!canAct}
          className={`w-full py-3.5 text-sm font-bold rounded-xl shadow-card transition ${canAct?actionBtn:"bg-slate-200 text-ink-400 cursor-not-allowed"}`}>
          {actionLabel}
        </button>
        {currentBlock&&<p className="text-[11px] text-ink-500 mt-2 text-center italic">{PHASE_DESC[phase]}</p>}
        {!canAct&&(
          <p className="text-[11px] text-ink-500 mt-2 text-center italic">
            {!currentBlock?"Add a block in the next card to get started.":"Fill in start + end dates on the block below."}
          </p>
        )}
      </div>

      {/* Blocks — full-width */}
      <SetupCard
        icon="🗓"
        title="Blocks"
        subtitle="Create a new block when the current one wraps. Old blocks stay available — switch between them to review history."
        action={
          <button onClick={()=>{
            const id = Date.now();
            const n = (config.blocks?.length||0) + 1;
            const nb = { id, name:`Block ${n}`, start:"", end:"", phase: PHASE.AVAIL };
            updateConfig({blocks:[...(config.blocks||[]), nb], currentBlockId:id});
          }}
            className="text-xs font-bold px-3 py-1.5 rounded-lg bg-brand-50 text-brand-700 hover:bg-brand-100 flex-shrink-0">
            + New block
          </button>
        }>
        {(!config.blocks||config.blocks.length===0)?(
          <p className="text-xs text-ink-500 italic py-4 text-center">No blocks yet. Tap <span className="font-semibold">+ New block</span> to create your first.</p>
        ):(
          <div className="space-y-2">
            {config.blocks.map((b, i) => {
              const isCur = b.id === config.currentBlockId;
              const patchBlock = patch => {
                const blocks = config.blocks.map(x => x.id===b.id ? {...x, ...patch} : x);
                updateConfig({blocks});
              };
              return(
                <div key={b.id} className={`rounded-xl border p-3 transition ${isCur?"border-brand-400 bg-brand-50/60":"border-slate-200 bg-white hover:bg-slate-50"}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <input value={b.name||""} onChange={e=>patchBlock({name:e.target.value})}
                      placeholder={`Block ${i+1}`}
                      className="flex-1 min-w-0 px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm font-semibold bg-white"/>
                    {isCur?(
                      <span className="text-[10px] px-2.5 py-1 rounded-full bg-brand-600 text-white font-bold uppercase tracking-wider">Current</span>
                    ):(
                      <button onClick={()=>updateConfig({currentBlockId:b.id})}
                        className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-ink-700">
                        Make current
                      </button>
                    )}
                    {config.blocks.length>1&&<button onClick={()=>{
                      if(!confirm(`Delete "${b.name||"this block"}"? Shifts that fall inside its dates stay in history but will no longer be visible as a block.`)) return;
                      const remaining = config.blocks.filter(x=>x.id!==b.id);
                      const nextCurrent = isCur ? (remaining[0]?.id||null) : config.currentBlockId;
                      updateConfig({blocks:remaining, currentBlockId:nextCurrent});
                    }} className="text-red-500 hover:text-red-700 px-1.5 text-sm" title="Delete block">✕</button>}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[10px] font-bold text-ink-500 uppercase tracking-wider mb-1">Start</div>
                      <input type="date" value={b.start||""} onChange={e=>patchBlock({start:e.target.value})}
                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm bg-white"/>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold text-ink-500 uppercase tracking-wider mb-1">End</div>
                      <input type="date" value={b.end||""} onChange={e=>patchBlock({end:e.target.value})}
                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm bg-white"/>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    {(()=>{ const bp=phaseOf(b); const bt=PHASE_TONE[bp]; return (
                      <span className={`inline-flex items-center gap-1 font-semibold ${bt.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${bt.dot}`}></span>
                        {PHASE_LABEL[bp]}
                      </span>
                    ); })()}
                    {isCur&&<span className="text-ink-400 italic">Phase changes via the action button above</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SetupCard>

      {/* 2-col: Shift slots + Seniority levels */}
      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <SetupCard icon="🎯" title="Shift slots per day" subtitle="Define the slots filled each day and each slot's credit weight.">
          <div className="space-y-2">
            {config.shiftSlots.map((s,i)=>(
              <div key={s.id} className="flex items-center gap-2">
                <input type="color" value={s.color} onChange={e=>{const n=[...config.shiftSlots];n[i]={...n[i],color:e.target.value};updateConfig({shiftSlots:n});}} className="w-9 h-9 rounded-lg border border-slate-200 cursor-pointer flex-shrink-0"/>
                <input value={s.name} onChange={e=>{const n=[...config.shiftSlots];n[i]={...n[i],name:e.target.value};updateConfig({shiftSlots:n});}} className="flex-1 min-w-0 px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"/>
                <input type="number" step="0.05" min="0" max="2" value={s.credit} onChange={e=>{const n=[...config.shiftSlots];n[i]={...n[i],credit:parseFloat(e.target.value)||0};updateConfig({shiftSlots:n});}} className="w-16 px-2 py-2 border border-slate-200 rounded-lg text-sm text-center tabular-nums bg-white"/>
                {config.shiftSlots.length>1&&<button onClick={()=>updateConfig({shiftSlots:config.shiftSlots.filter(x=>x.id!==s.id)})} className="text-red-500 hover:text-red-700 px-1.5 flex-shrink-0">✕</button>}
              </div>
            ))}
            <button onClick={()=>updateConfig({shiftSlots:[...config.shiftSlots,{id:Date.now(),name:"New slot",credit:1.0,color:COLORS[config.shiftSlots.length%COLORS.length]}]})}
              className="px-3 py-2 text-xs font-semibold border-2 border-dashed border-slate-200 rounded-xl hover:bg-slate-50 hover:border-brand-300 hover:text-brand-700 w-full text-ink-500 transition">
              + Add slot
            </button>
          </div>
        </SetupCard>

        <SetupCard icon="🎓" title="Seniority levels" subtitle="Named tiers with minimum shift floors. Floors drive the min slider on each provider's schedule.">
          <div className="space-y-2">
            {config.seniorityLevels.map((l,i)=>(
              <div key={l.id} className="flex items-center gap-2">
                <input value={l.name} onChange={e=>{const n=[...config.seniorityLevels];n[i]={...n[i],name:e.target.value};updateConfig({seniorityLevels:n});}} className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white" placeholder="Level name"/>
                <span className="text-[10px] font-bold text-ink-500 uppercase tracking-wider">Min</span>
                <input type="number" min="0" value={l.minShifts} onChange={e=>{const n=[...config.seniorityLevels];n[i]={...n[i],minShifts:parseInt(e.target.value)||0};updateConfig({seniorityLevels:n});}} className="w-14 px-2 py-2 border border-slate-200 rounded-lg text-sm text-center tabular-nums bg-white"/>
                {config.seniorityLevels.length>1&&<button onClick={()=>updateConfig({seniorityLevels:config.seniorityLevels.filter(x=>x.id!==l.id)})} className="text-red-500 hover:text-red-700 px-1.5 flex-shrink-0">✕</button>}
              </div>
            ))}
            <button onClick={()=>updateConfig({seniorityLevels:[...config.seniorityLevels,{id:Date.now(),name:"New level",minShifts:2}]})}
              className="px-3 py-2 text-xs font-semibold border-2 border-dashed border-slate-200 rounded-xl hover:bg-slate-50 hover:border-brand-300 hover:text-brand-700 w-full text-ink-500 transition">
              + Add level
            </button>
          </div>
        </SetupCard>
      </div>

      {/* Point values — full-width (5 day types fit side-by-side) */}
      <div className="mt-4">
        <SetupCard
          icon="⭐"
          title="Point values"
          subtitle="How many points each day type is worth. Weekends and holidays usually score higher to balance the load."
          action={
            <button onClick={()=>updateConfig({pointValuesLocked:!config.pointValuesLocked})}
              className={`text-xs font-bold px-3 py-1.5 rounded-lg flex-shrink-0 ${config.pointValuesLocked?"bg-brand-50 text-brand-700 hover:bg-brand-100":"bg-amber-50 text-amber-700 hover:bg-amber-100"}`}>
              {config.pointValuesLocked?"🔒 Unlock":"Lock"}
            </button>
          }>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[["weekday","Mon-Thu"],["fri","Fri"],["sat","Sat"],["sun","Sun"],["holiday","Holiday"]].map(([k,l])=>(
              <div key={k}>
                <div className="text-[10px] font-bold text-ink-500 uppercase tracking-[0.12em] mb-1.5">{l}</div>
                <input type="number" step="0.5" value={config.pointValues[k]} disabled={config.pointValuesLocked}
                  onChange={e=>updateConfig({pointValues:{...config.pointValues,[k]:parseFloat(e.target.value)||0}})}
                  className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-lg font-bold tabular-nums text-center ${config.pointValuesLocked?"bg-slate-50 text-ink-500 cursor-not-allowed":"bg-white text-ink-900"}`}/>
              </div>
            ))}
          </div>
          {config.pointValuesLocked&&<p className="text-[11px] text-ink-500 mt-3 italic">Using default point values. Tap <span className="font-semibold">🔒 Unlock</span> to edit.</p>}
        </SetupCard>
      </div>

      {/* 2-col: Availability requirements + Scoring bonuses */}
      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <SetupCard icon="📋" title="Availability requirements" subtitle="How many days each provider must prefer, and how many days they can block. Points deducted for violation of either requirement.">
          <div className="space-y-4">
            {/* Row 1 — Preferred days required */}
            <div>
              <div className="text-xs font-bold text-emerald-700 uppercase tracking-[0.1em] mb-2 flex items-center gap-1.5">
                <span>⭐</span> Preferred days required
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  ["Min days", config.minPreferredDays, v=>updateConfig({minPreferredDays:parseInt(v)||0}), "0", "1"],
                  ["Min weekends", config.minPreferredWeekendDays, v=>updateConfig({minPreferredWeekendDays:parseInt(v)||0}), "0", "1"],
                  ["Pts deducted", config.preferredShortfallPenalty, v=>updateConfig({preferredShortfallPenalty:parseFloat(v)||0}), "0", "0.5"],
                ].map(([l,v,set,min,step])=>(
                  <div key={l}>
                    <div className="text-[10px] font-bold text-ink-500 uppercase tracking-[0.1em] mb-1.5">{l}</div>
                    <input type="number" min={min} step={step} value={v} onChange={e=>set(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-lg font-bold tabular-nums text-center bg-white text-ink-900"/>
                  </div>
                ))}
              </div>
            </div>
            {/* Row 2 — Blocked days allowed */}
            <div className="pt-3 border-t border-slate-200">
              <div className="text-xs font-bold text-red-600 uppercase tracking-[0.1em] mb-2 flex items-center gap-1.5">
                <span>✕</span> Blocked days allowed
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  ["Max days", config.maxBlockedDays, v=>updateConfig({maxBlockedDays:parseInt(v)||0}), "0", "1"],
                  ["Max weekends", config.maxBlockedWeekendDays, v=>updateConfig({maxBlockedWeekendDays:parseInt(v)||0}), "0", "1"],
                  ["Pts / extra", config.blockOverLimitPenalty, v=>updateConfig({blockOverLimitPenalty:parseFloat(v)||0}), "0", "0.5"],
                ].map(([l,v,set,min,step])=>(
                  <div key={l}>
                    <div className="text-[10px] font-bold text-ink-500 uppercase tracking-[0.1em] mb-1.5">{l}</div>
                    <input type="number" min={min} step={step} value={v} onChange={e=>set(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-lg font-bold tabular-nums text-center bg-white text-ink-900"/>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-ink-500 mt-2 italic leading-relaxed">
                Providers are warned and can spend a point per extra block. Once their running total would dip below zero, additional blocks are forbidden.
              </p>
            </div>
          </div>
        </SetupCard>

        <SetupCard icon="🎁" title="Scoring bonuses" subtitle="Extra points for involuntary and non-preferred shifts. Contested slots are settled by user-set bids.">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] font-bold text-ink-500 uppercase tracking-[0.12em] mb-1.5">Auto-assigned bonus</div>
                <input type="number" min="0" step="0.5" value={config.involuntaryBonus}
                  onChange={e=>updateConfig({involuntaryBonus:parseFloat(e.target.value)||0})}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-lg font-bold tabular-nums text-center bg-white text-ink-900"/>
              </div>
              <div>
                <div className="text-[10px] font-bold text-ink-500 uppercase tracking-[0.12em] mb-1.5">Non-preferred bonus</div>
                <input type="number" min="0" step="0.5" value={config.nonPreferredBonus??1}
                  onChange={e=>updateConfig({nonPreferredBonus:parseFloat(e.target.value)||0})}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-lg font-bold tabular-nums text-center bg-white text-ink-900"/>
              </div>
            </div>
            <p className="text-[11px] text-ink-500 leading-relaxed bg-slate-50 rounded-xl p-3 border border-slate-200">
              Auto-assign bonus applies to every auto-filled shift. Non-preferred bonus is <span className="font-semibold text-ink-700">added on top</span> when the user didn't star that date. Contested slots are decided by <span className="font-semibold text-ink-700">user bids</span> — winners pay the points they bid (default <span className="font-semibold text-ink-700">1 pt</span>, capped at their current total).
            </p>
          </div>
        </SetupCard>
      </div>

      {/* Holidays — full-width */}
      <div className="mt-4">
        <SetupCard icon="🎉" title="Holidays" subtitle="Dates that score holiday-rate points. Use the sub-form to add new ones.">
          {holidayList.length>0 && (
            <div className="space-y-2 mb-3">
              {holidayList.map(([d,n])=>(
                <div key={d} className="flex items-center gap-2">
                  <input type="date" value={d} disabled className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 tabular-nums flex-shrink-0"/>
                  <input type="text" value={n} placeholder="Name" onChange={e=>updateConfig({holidays:{...config.holidays,[d]:e.target.value}})} className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"/>
                  <button onClick={()=>{const h={...config.holidays};delete h[d];updateConfig({holidays:h});}} className="text-red-500 hover:text-red-700 px-1.5 flex-shrink-0">✕</button>
                </div>
              ))}
            </div>
          )}
          <div className="pt-3 border-t border-slate-200">
            <div className="text-[10px] font-bold text-ink-500 uppercase tracking-[0.12em] mb-2">Add holiday</div>
            <AddHoliday onAdd={(d,n)=>updateConfig({holidays:{...config.holidays,[d]:n}})}/>
          </div>
        </SetupCard>
      </div>
    </>);
  };

  const PeoplePage = () => (<>
    <div className="flex items-start justify-between mb-1 gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">People</h1>
        <p className="text-sm text-slate-500">Assign seniority and adjust points.</p>
      </div>
      {me.role==="admin"&&(
        <div className="flex-shrink-0 flex items-center gap-2">
          {/* Phase A cloud invite. Visible only when admin is signed in to cloud AND this group
              has been mirrored to D1 (cloudGroupId set at create-time). API enforces that the
              caller is the cloud-owner of the group; if not, flash() reports the failure. */}
          {cloudUser&&currentGroup?.cloudGroupId&&(
            <button onClick={()=>createCloudInvite(currentGroup.cloudGroupId)}
              className="text-sm font-medium px-3 py-2 rounded-lg border border-blue-600 text-blue-700 hover:bg-blue-50">
              + Invite link
            </button>
          )}
          <button onClick={()=>{setAddUserForm({name:"",username:"",email:"",role:"provider",seniorityId:""});setAddUserOpen(true);}} className="bg-blue-600 text-white text-sm font-medium px-3 py-2 rounded-lg hover:bg-blue-700">+ Add user</button>
        </div>
      )}
    </div>
    <div className="mb-4"></div>
    <div className="space-y-2">
      {users.map(u=>{
        const earned=getPtsEarned(u.id), a=u.role==="provider"?getAvailInfo(u.id):null;
        return(
          <div key={u.id} className="bg-white rounded-xl border border-slate-200 p-3">
            <div className="flex items-start gap-3 mb-2">
              <div className="w-10 h-10 rounded-full text-white flex items-center justify-center text-sm font-semibold flex-shrink-0" style={{background:COLORS[u.id%COLORS.length]}}>{initials(u.name)}</div>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{u.name}</div>
                <div className="text-xs text-slate-500">@{u.username} · <span className={u.role==="admin"?"text-purple-600 font-medium":""}>{u.role}</span></div>
              </div>
              {u.id!==me.id&&<button onClick={()=>deleteUser(u.id)} className="text-red-500 hover:text-red-700 text-xs px-2">Delete</button>}
            </div>
            {u.role==="provider"&&(
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500 flex-shrink-0 w-20">Seniority</label>
                  <select value={u.seniorityId||""} onChange={e=>updateUser(u.id,{seniorityId:e.target.value?parseInt(e.target.value):null})} className="flex-1 text-sm border border-slate-300 rounded-lg px-2 py-1.5 bg-white">
                    <option value="">— Unassigned —</option>
                    {config.seniorityLevels.map(l=><option key={l.id} value={l.id}>{l.name} (min {l.minShifts})</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500 flex-shrink-0 w-20">Prior pts</label>
                  <button onClick={()=>adjustPoints(u.id,-1)} className="w-8 h-8 border border-slate-300 rounded hover:bg-slate-50">−</button>
                  <span className="font-semibold text-blue-600 min-w-[2rem] text-center">{u.points}</span>
                  <button onClick={()=>adjustPoints(u.id,1)} className="w-8 h-8 border border-slate-300 rounded hover:bg-slate-50">+</button>
                </div>
                <div className="text-xs text-slate-500" style={{paddingLeft:"5.5rem"}}>
                  Spendable <span className="font-semibold">{totalPts(u.id).toFixed(1)}</span>{a?.penalty>0?<span className="text-red-600"> (−{a.penalty} penalty)</span>:""} · Projected this block: <span className="text-emerald-700 font-medium">+{earned.toFixed(1)}</span>
                </div>
                <div className="text-xs text-slate-500" style={{paddingLeft:"5.5rem"}}>
                  Targets: <span className="font-medium">{(u.targets?.min)||0}/{(u.targets?.ideal)||0}/{(u.targets?.max)||0}</span> min/ideal/max · <span className="text-emerald-600 font-medium">{wantedCount(u.id)} preferred</span>
                </div>
                {(() => {
                  const sp = u.spacingPref;
                  if(!sp || sp.mode==="none") return null;
                  const label = sp.mode==="consecutive"
                    ? `Back-to-back OK · max ${sp.maxConsecutive||3} in a row`
                    : `Spread out · ≥${sp.minGap||2} day${(sp.minGap||2)===1?"":"s"} between shifts`;
                  return <div className="text-xs text-slate-500" style={{paddingLeft:"5.5rem"}}>Spacing: <span className="font-medium">{label}</span></div>;
                })()}
                {a&&!a.meets&&(
                  <div className="text-xs bg-red-50 text-red-700 px-2 py-1.5 rounded space-y-0.5">
                    {!a.prefMeets&&<div>⚠ Pref: {a.pref}/{config.minPreferredDays} days, {a.prefWk}/{config.minPreferredWeekendDays} wknd</div>}
                    {!a.blockMeets&&<div>⚠ Blocks: {a.blocked}/{config.maxBlockedDays} days, {a.blockedWk}/{config.maxBlockedWeekendDays} wknd</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </>);

  /* ══ SUPER (OWNER) DASHBOARD ══ */
  const copyCode = (c) => {
    try { navigator.clipboard?.writeText(c); setCopied(c); setTimeout(()=>setCopied(""), 1500); flash("Copied"); } catch { flash("⚠️ Copy failed"); }
  };
  // Reads a per-group localStorage value (shyft3_ namespace) and JSON-parses it. Returns
  // `fallback` if the key is missing or unparseable. Used by the Owner dashboard to inspect
  // groups the Owner isn't currently loaded into — Owner accounts have no `groupId` so the
  // in-memory `users`/`config`/etc state is empty for them, but localStorage has everything.
  const readGroupKey = (gid, k, fallback) => {
    try { const raw = localStorage.getItem("shyft3_"+gKey(gid,k)); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };
  // Aggregate stats for one group, computed cold from localStorage. Safe to call for any
  // group regardless of which one (if any) is currently loaded.
  const getGroupStats = (gid) => {
    const gusers = readGroupKey(gid, "users", []);
    const cfg = readGroupKey(gid, "config", null);
    const market = readGroupKey(gid, "marketplace", []);
    const blocks = (cfg && Array.isArray(cfg.blocks)) ? cfg.blocks : [];
    const activeBlock = (cfg && cfg.currentBlockId) ? blocks.find(b=>b.id===cfg.currentBlockId) : null;
    // Block ids are Date.now() at create-time (see Setup → New block), so the max id is a
    // reasonable proxy for "newest write" along with user.createdAt and marketplace timestamps.
    let lastActivity = 0;
    for(const b of blocks){ if(b.id>lastActivity) lastActivity = b.id; }
    for(const u of gusers){ if(u.createdAt && u.createdAt>lastActivity) lastActivity = u.createdAt; }
    for(const l of market){
      if(l.postedAt && l.postedAt>lastActivity) lastActivity = l.postedAt;
      if(l.takenAt  && l.takenAt >lastActivity) lastActivity = l.takenAt;
    }
    return {
      admins: gusers.filter(u=>u.role==="admin").length,
      providers: gusers.filter(u=>u.role==="provider").length,
      members: gusers.length,
      blocksTotal: blocks.length,
      blocksLocked: blocks.filter(b=>phaseOf(b)===PHASE.LOCKED).length,
      activeBlock: activeBlock ? {phase: phaseOf(activeBlock), name: activeBlock.name||"", start: activeBlock.start||"", end: activeBlock.end||""} : null,
      lastActivity: lastActivity || null,
    };
  };
  // Owner action: rename a group. Updates groups[] in root storage; per-group data unaffected.
  const renameGroup = async (gid, newName) => {
    const name = (newName||"").trim();
    if(!name){ flash("⚠️ Name required"); return; }
    const next = groups.map(g => g.id===gid ? {...g, name} : g);
    setGroups(next); await persistRoot("groups", next);
    flash(`✏️ Renamed to "${name}"`);
  };
  // Owner action: regenerate both join codes for a group. Existing user accounts (which sign
  // in by username/password) keep working — only new joiners need the new codes.
  const rollGroupCodes = async (gid) => {
    const g = groups.find(x=>x.id===gid); if(!g) return;
    if(!confirm(`Generate new group + admin codes for "${g.name}"? The old codes will stop working immediately. Existing members can still sign in.`)) return;
    const taken = new Set(groups.flatMap(x=>x.id===gid?[]:[x.groupCode,x.adminCode]));
    let gc, ac;
    do { gc = genCode(6); } while(taken.has(gc));
    do { ac = genCode(6); } while(taken.has(ac) || ac===gc);
    const next = groups.map(x => x.id===gid ? {...x, groupCode:gc, adminCode:ac} : x);
    setGroups(next); await persistRoot("groups", next);
    flash(`🔄 New codes for "${g.name}"`);
  };
  // Compact relative-time formatter for the last-activity hint on each Owner card.
  const fmtAgo = (ts) => {
    if(!ts) return "—";
    const s = Math.floor((Date.now()-ts)/1000);
    if(s<60) return "just now";
    if(s<3600) return `${Math.floor(s/60)}m ago`;
    if(s<86400) return `${Math.floor(s/3600)}h ago`;
    if(s<604800) return `${Math.floor(s/86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  };
  const SuperDashboard = () => {
    // Per-group stats computed cold from localStorage; aggregated for the platform totals strip.
    const allStats = groups.map(g => ({...getGroupStats(g.id), gid:g.id}));
    const totals = allStats.reduce((a,s)=>({
      admins: a.admins + s.admins,
      providers: a.providers + s.providers,
      blocks: a.blocks + s.blocksTotal,
      active: a.active + (s.activeBlock ? 1 : 0),
    }), {admins:0, providers:0, blocks:0, active:0});

    return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <ShiftIcon size={32}/>
          <span className="font-semibold text-slate-900">SHIFT</span>
          <span className="ml-2 text-[10px] sm:text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium whitespace-nowrap">Owner</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-sm text-slate-700">{me.name}</span>
          <button onClick={signOut} className="text-xs sm:text-sm px-3 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50">Sign out</button>
        </div>
      </nav>
      {/* Phase A: cloud-account strip. Visible only when signed in via magic link. */}
      {cloudUser&&(
        <div className="bg-blue-50 border-b border-blue-200 px-4 sm:px-6 py-1.5 flex items-center justify-between text-xs">
          <span className="text-blue-800">Cloud: <span className="font-medium">{cloudUser.user.email}</span></span>
          <button onClick={signOutCloud} className="text-blue-700 hover:text-blue-900 font-medium">Sign out (cloud)</button>
        </div>
      )}
      <main className="p-4 sm:p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Groups</h1>
        <p className="text-sm text-slate-500 mb-4">Every group has its own users, calendar, and settings. Share the codes with the group's members.</p>

        {/* Platform totals strip — one-glance summary across every group. Hidden when there
            are zero groups (the empty-state below carries the call-to-action instead). */}
        {groups.length>0&&(
          <div className="grid grid-cols-4 gap-2 mb-4">
            <div className="bg-white rounded-lg border border-slate-200 p-2.5 text-center">
              <div className="text-lg font-semibold text-slate-900 tabular-nums leading-tight">{groups.length}</div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Group{groups.length===1?"":"s"}</div>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-2.5 text-center">
              <div className="text-lg font-semibold text-slate-900 tabular-nums leading-tight">{totals.admins}</div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Admin{totals.admins===1?"":"s"}</div>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-2.5 text-center">
              <div className="text-lg font-semibold text-slate-900 tabular-nums leading-tight">{totals.providers}</div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Providers</div>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-2.5 text-center">
              <div className="text-lg font-semibold text-slate-900 tabular-nums leading-tight">
                {totals.blocks}<span className="text-xs font-medium text-slate-400 ml-1">· {totals.active} live</span>
              </div>
              <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Blocks</div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
          <div className="font-semibold mb-3">Create a new group</div>
          <div className="flex gap-2">
            <input value={groupForm.name} onChange={e=>setGroupForm({name:e.target.value})} onKeyDown={e=>{if(e.key==="Enter"&&groupForm.name.trim()){createGroup(groupForm.name);setGroupForm({name:""});}}}
              className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="Group name (e.g. ED Attendings)"/>
            <button onClick={async()=>{ if(!groupForm.name.trim()) return; await createGroup(groupForm.name); setGroupForm({name:""}); }}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg">
              + Create
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">Both codes are auto-generated. Share the <span className="font-medium">group code</span> with all members, and the <span className="font-medium">admin code</span> only with whoever should administer the group.</p>
        </div>

        {groups.length===0?(
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
            No groups yet. Create one above to get started.
          </div>
        ):(
          <div className="space-y-2">{groups.slice().sort((a,b)=>b.createdAt-a.createdAt).map(g=>{
            const s = getGroupStats(g.id);
            const renaming = renamingGid===g.id;
            const tone = s.activeBlock ? PHASE_TONE[s.activeBlock.phase] : null;
            return(
              <div key={g.id} className="bg-white rounded-xl border border-slate-200 p-4">
                {/* Header: name (or inline rename input) + actions row. */}
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div className="flex-1 min-w-0">
                    {renaming?(
                      <div className="flex gap-1.5 items-center">
                        <input autoFocus value={renameValue} onChange={e=>setRenameValue(e.target.value)}
                          onKeyDown={e=>{
                            if(e.key==="Enter"){ renameGroup(g.id, renameValue); setRenamingGid(null); }
                            if(e.key==="Escape") setRenamingGid(null);
                          }}
                          className="flex-1 px-2 py-1 border border-slate-300 rounded text-base font-semibold"/>
                        <button onClick={()=>{ renameGroup(g.id, renameValue); setRenamingGid(null); }}
                          className="text-xs font-medium text-emerald-700 hover:text-emerald-800 px-2 py-1">Save</button>
                        <button onClick={()=>setRenamingGid(null)}
                          className="text-xs font-medium text-slate-500 hover:text-slate-700 px-2 py-1">Cancel</button>
                      </div>
                    ):(
                      <div className="font-semibold text-base truncate">{g.name}</div>
                    )}
                    <div className="text-xs text-slate-500 mt-0.5">
                      Last activity {fmtAgo(s.lastActivity)} · created {new Date(g.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  {!renaming&&(
                    <div className="flex items-center flex-shrink-0">
                      <button onClick={()=>{ setRenameValue(g.name); setRenamingGid(g.id); }} className="text-slate-600 hover:text-slate-900 text-xs font-medium px-2 py-1">Rename</button>
                      <button onClick={()=>rollGroupCodes(g.id)} className="text-slate-600 hover:text-slate-900 text-xs font-medium px-2 py-1">Roll codes</button>
                      {!g.cloudGroupId && cloudUser && (
                        <button onClick={()=>startMigrateGroup(g)} className="text-blue-600 hover:text-blue-700 text-xs font-medium px-2 py-1">Migrate to cloud</button>
                      )}
                      <button onClick={()=>deleteGroup(g.id)} className="text-red-600 hover:text-red-700 text-xs font-medium px-2 py-1">Delete</button>
                    </div>
                  )}
                </div>

                {/* Stat strip — admins · providers · blocks(/locked) · active phase. */}
                <div className="grid grid-cols-4 gap-2 my-3">
                  <div className="bg-slate-50 rounded-lg p-2 text-center">
                    <div className="text-base font-semibold text-slate-900 tabular-nums leading-tight">{s.admins}</div>
                    <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Admin{s.admins===1?"":"s"}</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-2 text-center">
                    <div className="text-base font-semibold text-slate-900 tabular-nums leading-tight">{s.providers}</div>
                    <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Providers</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-2 text-center">
                    <div className="text-base font-semibold text-slate-900 tabular-nums leading-tight">
                      {s.blocksTotal}<span className="text-xs font-medium text-slate-400 ml-1">· {s.blocksLocked} lk</span>
                    </div>
                    <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Blocks</div>
                  </div>
                  <div className={`rounded-lg p-2 text-center border ${tone?`${tone.bg} ${tone.border}`:"bg-slate-50 border-transparent"}`}>
                    {s.activeBlock?(
                      <>
                        <div className={`text-xs font-semibold leading-tight ${tone.text} truncate`}>{PHASE_LABEL[s.activeBlock.phase]}</div>
                        <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide truncate">{s.activeBlock.name||"Active"}</div>
                      </>
                    ):(
                      <>
                        <div className="text-xs font-medium text-slate-400 leading-tight">No active</div>
                        <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Block</div>
                      </>
                    )}
                  </div>
                </div>

                {/* Codes — unchanged from previous design. */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-slate-50 rounded-lg p-2.5">
                    <div className="text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Group code</div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base font-semibold text-slate-800 tracking-wider">{g.groupCode}</span>
                      <button onClick={()=>copyCode(g.groupCode)} className="ml-auto text-[11px] text-blue-600 hover:text-blue-800 font-medium">{copied===g.groupCode?"Copied":"Copy"}</button>
                    </div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2.5">
                    <div className="text-[10px] font-medium text-purple-700 mb-1 uppercase tracking-wide">Admin code</div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base font-semibold text-purple-900 tracking-wider">{g.adminCode}</span>
                      <button onClick={()=>copyCode(g.adminCode)} className="ml-auto text-[11px] text-purple-700 hover:text-purple-900 font-medium">{copied===g.adminCode?"Copied":"Copy"}</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}</div>
        )}

        <div className="mt-6 text-xs text-slate-400 text-center">
          {supers.length} owner account{supers.length===1?"":"s"}. New owners register at the Owner tab on the sign-in screen with the bootstrap code.
        </div>
      </main>
      {migrateState && <MigrateModal/>}
      {toast&&<Toast msg={toast}/>}
    </div>
    );
  };

  // Phase D.2: confirm-then-result modal for migrating a local group to the cloud.
  // Confirm phase lists every local user about to become a cloud test user.
  // Result phase lists each user with their synthetic email + temp password — the only
  // chance the admin has to capture them.
  const MigrateModal = () => {
    if (!migrateState) return null;
    const { phase, group, localUsers, result } = migrateState;
    const copyAll = () => {
      if (!result?.users?.length) return;
      const lines = result.users.map(u => `${u.name} (${u.role}): ${u.email}  ${u.tempPassword}`).join("\n");
      try { navigator.clipboard?.writeText(lines); flash("Cloud credentials copied"); } catch { flash("⚠️ Copy failed"); }
    };
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={cancelMigrate}>
        <div className="bg-white rounded-2xl max-w-lg w-full p-5 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
          {phase === "confirm" ? (<>
            <div className="text-2xl mb-1">☁️</div>
            <div className="font-semibold text-xl mb-1">Migrate "{group.name}" to cloud</div>
            <p className="text-sm text-slate-500 mb-3">
              Creates a cloud group with you as the owner. {localUsers.length} local user{localUsers.length===1?"":"s"} will become cloud <span className="font-medium">test users</span> — synthetic emails, no magic-link sent. Their passwords are shown once on the next screen so you can hand them out for testing.
            </p>
            <div className="bg-slate-50 rounded-lg p-3 mb-4 max-h-48 overflow-y-auto">
              {localUsers.length === 0
                ? <div className="text-sm text-slate-500 italic">No local users — only the group itself will be migrated.</div>
                : localUsers.map(u => (
                  <div key={u.id} className="flex justify-between text-sm py-1">
                    <span className="font-medium text-slate-800">{u.name}</span>
                    <span className="text-slate-500">{u.role}</span>
                  </div>
                ))
              }
            </div>
            <div className="flex gap-2">
              <button onClick={cancelMigrate} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
              <button onClick={confirmMigrate} className="flex-1 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">Migrate</button>
            </div>
          </>) : (<>
            <div className="text-2xl mb-1">✅</div>
            <div className="font-semibold text-xl mb-1">"{group.name}" migrated</div>
            <p className="text-sm text-slate-500 mb-3">Each test user can sign in via the Cloud tab using the email and password below. Copy or screenshot now — passwords are not stored anywhere retrievable.</p>
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-3">Saving these is your responsibility — Cloudflare won't show them again.</p>
            <div className="bg-slate-50 rounded-lg p-3 mb-3 max-h-72 overflow-y-auto space-y-2">
              {(result?.users||[]).map(u => (
                <div key={u.email} className="border-b border-slate-200 last:border-b-0 pb-2 last:pb-0">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-sm text-slate-900">{u.name}</div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">{u.role}</div>
                  </div>
                  <div className="font-mono text-[11px] text-slate-600 break-all">{u.email}</div>
                  <div className="font-mono text-sm font-bold tracking-wider text-slate-900">{u.tempPassword}</div>
                </div>
              ))}
              {(!result?.users || result.users.length===0) && <div className="text-sm text-slate-500 italic">No test users created.</div>}
            </div>
            <div className="flex gap-2">
              <button onClick={copyAll} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">📋 Copy all</button>
              <button onClick={cancelMigrate} className="flex-1 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">Done</button>
            </div>
          </>)}
        </div>
      </div>
    );
  };

  /* ══ NAV & RENDER ══ */
  if(me.role==="super") return SuperDashboard();

  // Nav — Trades is shared (open listings live across providers + admin). Badge with count
  // is computed inline below.
  const openTradeCount = marketplace.filter(l => l.status === "open").length;
  const navItems = me.role==="admin"
    ? [{id:"home",icon:"📊",label:"Home"},{id:"shifts",icon:"📅",label:"Calendar"},{id:"market",icon:"🔄",label:"Trades",badge:openTradeCount||null},{id:"setup",icon:"⚙️",label:"Setup"},{id:"people",icon:"👥",label:"People"}]
    : [{id:"home",icon:"🏠",label:"Home"},{id:"schedule",icon:"📅",label:"Schedule"},{id:"myshifts",icon:"✅",label:"Mine"},{id:"market",icon:"🔄",label:"Trades",badge:openTradeCount||null},{id:"standings",icon:"⭐",label:"Ranks"}];

  const renderPage = () => {
    if(page==="home") return me.role==="admin"?AdminHome():ProviderHome();
    // "shifts" is the admin-side calendar page; providers land here too if they came from a pre-merge link.
    if(page==="shifts") return me.role==="admin"?ShiftsPage():SchedulePage();
    if(page==="schedule") return SchedulePage();
    // Legacy availability route → redirect to the merged schedule page.
    if(page==="availability") return SchedulePage();
    if(page==="myshifts") return MyShiftsPage();
    if(page==="market") return MarketplacePage();
    if(page==="standings") return StandingsPage();
    if(page==="setup") return SetupPage();
    if(page==="people") return PeoplePage();
  };

  // v2 shell: persistent sidebar on desktop (≥lg) with brand/block card/nav/user footer.
  // Mobile (<lg) keeps a slim topbar + bottom nav; content stays within max-w-5xl
  // with generous padding for breathing room the v1 layout didn't have.
  const blockRangeLabel = currentBlock && currentBlock.start && currentBlock.end
    ? `${MONTHS_SHORT[parseDk(currentBlock.start).getMonth()]} ${parseDk(currentBlock.start).getDate()} – ${MONTHS_SHORT[parseDk(currentBlock.end).getMonth()]} ${parseDk(currentBlock.end).getDate()}`
    : "Dates not set";
  return(
    <div className="min-h-screen bg-canvas text-ink-900 lg:flex pb-20 lg:pb-0">
      {/* Phase C cloud-sync banner — fires when /api/snapshots/:gid/latest reports a clientTs
          newer than this device's last persist. User clicks "Sync now" to overwrite local
          state with the cloud snapshot. */}
      {cloudSyncOffer&&(
        <div className="fixed top-0 inset-x-0 z-50 bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
          <div className="text-amber-900">
            <span className="font-medium">Newer version of this group available</span>
            <span className="text-amber-700"> from another device.</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={()=>setCloudSyncOffer(null)}
              className="text-xs font-medium text-amber-700 hover:text-amber-900 px-2 py-1">Dismiss</button>
            <button onClick={acceptCloudSync}
              className="text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg">Sync now</button>
          </div>
        </div>
      )}
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-[260px] flex-shrink-0 bg-surface border-r border-slate-200 px-4 py-5 sticky top-0 h-screen">
        <div className="mb-6 px-2">
          <ShiftLogo height={56}/>
          <div className="text-[10px] font-semibold text-brand-700 uppercase tracking-wider mt-1">v3 · preview</div>
        </div>
        {currentBlock&&(()=>{ const sp=phaseOf(currentBlock); const st=PHASE_TONE[sp]; return (
          <div className="mb-5 p-3.5 rounded-xl bg-brand-50 border border-brand-100">
            <div className="text-[10px] font-semibold text-brand-700 uppercase tracking-wider">Current block</div>
            <div className="text-sm font-semibold text-ink-900 mt-1 truncate">{currentBlock.name||"Block"}</div>
            <div className="text-xs text-ink-500 mt-0.5">{blockRangeLabel}</div>
            <div className={`text-[10px] font-semibold mt-2 inline-flex items-center gap-1.5 ${st.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`}></span>
              {PHASE_LABEL[sp]}
            </div>
          </div>
        ); })()}
        <nav className="flex-1 space-y-0.5">{navItems.map(n=>(
          <button key={n.id} onClick={()=>setPage(n.id)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm w-full text-left transition ${page===n.id?"bg-brand-50 text-brand-700 font-semibold":"text-ink-700 hover:bg-slate-100"}`}>
            <span className="text-base leading-none">{n.icon}</span>
            <span className="flex-1">{n.label}</span>
            {n.badge && <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded-full min-w-[18px] text-center">{n.badge}</span>}
          </button>
        ))}</nav>
        <div className="pt-4 border-t border-slate-200 mt-4">
          <div className="flex items-center gap-2.5 px-1">
            <span className="w-9 h-9 rounded-full text-white flex items-center justify-center text-xs font-semibold shadow-card flex-shrink-0" style={{background:COLORS[me.id%COLORS.length]}}>{initials(me.name)}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-ink-900 truncate">{me.name}</div>
              <div className="text-[10px] text-ink-500 uppercase tracking-wider font-semibold">{me.role}</div>
            </div>
          </div>
          <button onClick={signOut} className="w-full mt-3 text-xs font-semibold px-3 py-2 border border-slate-200 rounded-lg text-ink-700 hover:bg-slate-50">Sign out</button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile topbar */}
        <header className="lg:hidden bg-surface border-b border-slate-200 px-4 py-3 flex items-center justify-between sticky top-0 z-40">
          <div className="flex items-center gap-2 min-w-0">
            <ShiftIcon size={28} className="flex-shrink-0"/>
            {currentBlock&&(()=>{ const tp=phaseOf(currentBlock); const tt=PHASE_TONE[tp]; return (
              <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap font-semibold ${tt.bg} ${tt.text}`}>
                {currentBlock.name||"Block"} · {PHASE_LABEL[tp].toLowerCase()}
              </span>
            ); })()}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-full text-white flex items-center justify-center text-xs font-semibold shadow-card flex-shrink-0" style={{background:COLORS[me.id%COLORS.length]}}>{initials(me.name)}</span>
            <button onClick={signOut} className="text-[11px] font-semibold px-2.5 py-1.5 border border-slate-200 rounded-lg text-ink-700">Sign out</button>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-8 lg:px-10 lg:py-10 max-w-5xl w-full mx-auto">
          {renderPage()}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-surface border-t border-slate-200 flex z-40 pb-[env(safe-area-inset-bottom)]">
        {navItems.map(n=>(
          <button key={n.id} onClick={()=>setPage(n.id)}
            className={`flex-1 py-2.5 flex flex-col items-center gap-0.5 relative ${page===n.id?"text-brand-700":"text-ink-500"}`}>
            <span className="text-lg leading-none">{n.icon}</span>
            <span className="text-[10px] font-semibold">{n.label}</span>
            {n.badge && <span className="absolute top-1 right-[20%] text-[9px] font-bold bg-amber-500 text-white px-1.5 py-0.5 rounded-full min-w-[16px] text-center leading-none">{n.badge}</span>}
          </button>
        ))}
      </nav>

      {DaySheet()}{Onboarding()}{AutoAssignModal()}{ReconcileModal()}{ConfirmResetModal()}{ConfirmLockModal()}{ConfirmBlockOverModal()}{BlockReportModal()}{FlagDraftModal()}{ListDraftModal()}{TradeDraftModal()}{AddUserModal()}{NewUserInfoModal()}
      {toast&&<Toast msg={toast}/>}
    </div>
  );
}

// v2 Stat: card with uppercase micro-label, prominent value, optional sub.
// The color prop sets value color (e.g. "text-brand-700"); default is inky.
// Shift brand mark — calendar grid with a centered 4-point star, all in #4A90E2.
// The icon is self-colored (no surrounding tile needed); drop it directly in place of a tile.
const ShiftIcon = ({size=40, className=""}) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" className={className}>
    <rect x="8" y="12" width="48" height="52" rx="6" fill="#4A90E2" fillOpacity="0.15" stroke="#4A90E2" strokeWidth="3"/>
    <rect x="14" y="6" width="6" height="12" rx="2" fill="#4A90E2"/>
    <rect x="44" y="6" width="6" height="12" rx="2" fill="#4A90E2"/>
    <line x1="8" y1="24" x2="56" y2="24" stroke="#4A90E2" strokeWidth="3"/>
    <path d="M 32 34 L 35 42 L 32 50 L 29 42 Z" fill="#4A90E2"/>
    <path d="M 22 42 L 32 45 L 42 42 L 32 39 Z" fill="#4A90E2"/>
  </svg>
);
// Stacked Shift logotype — icon centered on top, "SHIFT" wordmark below, "SCHEDULING" subtitle.
// Used on the sign-in hero where vertical centerstage is appropriate.
const ShiftLogoStacked = ({height=140, className=""}) => (
  <svg height={height} viewBox="0 0 240 140" fill="none" aria-label="SHIFT Scheduling" className={className}>
    <g transform="translate(102, 0)">
      <rect x="6" y="16" width="36" height="40" rx="3" fill="#4A90E2" fillOpacity="0.1" stroke="#4A90E2" strokeWidth="2"/>
      <rect x="10" y="12" width="4" height="8" rx="1" fill="#4A90E2"/>
      <rect x="34" y="12" width="4" height="8" rx="1" fill="#4A90E2"/>
      <line x1="6" y1="24" x2="42" y2="24" stroke="#4A90E2" strokeWidth="2"/>
      <path d="M 24 32 L 26 38 L 24 44 L 22 38 Z" fill="#4A90E2"/>
      <path d="M 18 38 L 24 40 L 30 38 L 24 36 Z" fill="#4A90E2"/>
    </g>
    <text x="120" y="85" fontFamily="Inter, system-ui, -apple-system, sans-serif" fontSize="32" fontWeight="700" fill="#1f2937" letterSpacing="1" textAnchor="middle">SHIFT</text>
    <text x="120" y="105" fontFamily="Inter, system-ui, -apple-system, sans-serif" fontSize="14" fontWeight="500" fill="#4A90E2" letterSpacing="4" textAnchor="middle">SCHEDULING</text>
  </svg>
);
// Full Shift logotype — calendar icon + "SHIFT" wordmark. Pass dark={true} for the
// white-text variant (use on dark backgrounds). Sized by `height` (default 32px); width auto-scales.
const ShiftLogo = ({height=32, dark=false, className=""}) => {
  const fillOp = dark ? 0.15 : 0.1;
  const textFill = dark ? "#FFFFFF" : "#1f2937";
  return (
    <svg height={height} viewBox="0 0 240 80" fill="none" aria-label="SHIFT Scheduling" className={className}>
      <rect x="6" y="16" width="36" height="40" rx="3" fill="#4A90E2" fillOpacity={fillOp} stroke="#4A90E2" strokeWidth="2"/>
      <rect x="10" y="12" width="4" height="8" rx="1" fill="#4A90E2"/>
      <rect x="34" y="12" width="4" height="8" rx="1" fill="#4A90E2"/>
      <line x1="6" y1="24" x2="42" y2="24" stroke="#4A90E2" strokeWidth="2"/>
      <path d="M 24 32 L 26 38 L 24 44 L 22 38 Z" fill="#4A90E2"/>
      <path d="M 18 38 L 24 40 L 30 38 L 24 36 Z" fill="#4A90E2"/>
      <text x="56" y="45" fontFamily="Inter, system-ui, -apple-system, sans-serif" fontSize="28" fontWeight="700" fill={textFill} letterSpacing="1">SHIFT</text>
    </svg>
  );
};
const Stat = ({label,value,color,small,sub}) => (
  <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-4 sm:p-5">
    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-500 mb-1.5">{label}</div>
    <div className={`font-extrabold tabular-nums leading-none ${small?"text-base sm:text-lg":"text-2xl sm:text-3xl"} ${color||"text-ink-900"}`}>{value}</div>
    {sub&&<div className="text-[11px] text-ink-500 mt-1.5 font-medium">{sub}</div>}
  </div>
);
// Module-scope so its identity is stable across renders — defining it inside SetupPage caused
// every keystroke to remount the inputs and lose focus.
const SetupCard = ({icon, title, subtitle, action, children}) => (
  <div className="bg-surface rounded-2xl shadow-card border border-slate-200/70 p-5 sm:p-6">
    <div className="flex flex-wrap items-start gap-3 mb-4">
      <div className="flex items-start gap-2 flex-1 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-brand-50 text-brand-700 flex items-center justify-center font-bold flex-shrink-0">{icon}</div>
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-ink-900 leading-tight">{title}</h2>
          {subtitle&&<p className="text-xs sm:text-sm text-ink-500 mt-1 leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
    {children}
  </div>
);
const Field = ({label,children}) => (<div className="mb-3"><div className="text-xs font-medium text-slate-600 mb-1">{label}</div>{children}</div>);
const Toast = ({msg}) => (<div className="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm shadow-lg z-50">{msg}</div>);
const Legend = ({color,ring,label}) => (<span className="flex items-center gap-1"><span className={`inline-block w-3 h-3 rounded ${color||""} ${ring||""}`}/>{label}</span>);
const AddHoliday = ({onAdd}) => {
  const [d,setD]=useState(""); const [n,setN]=useState("");
  return(
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      <input type="date" value={d} onChange={e=>setD(e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm"/>
      <input type="text" value={n} onChange={e=>setN(e.target.value)} placeholder="Holiday name" className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm"/>
      <button onClick={()=>{if(d&&n){onAdd(d,n);setD("");setN("");}}} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">Add</button>
    </div>
  );
};
