import React, { useState, useEffect, useMemo } from "react";

const DAYS_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAYS_LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const COLORS = ["#3B82F6","#8B5CF6","#EC4899","#10B981","#F59E0B","#EF4444","#06B6D4","#84CC16","#F97316","#A855F7"];
const UNAVAIL_REASONS = ["Working","Vacation","Conference","Personal Conflict"];

const DEFAULT_CONFIG = {
  // Multi-block model: `blocks` is an ordered list of scheduling windows.
  // Each block: { id, name, start, end, signupOpen }. `currentBlockId` picks the active one.
  // Data (shifts, preferences, unavailability) is stored keyed by date, so old blocks stay readable.
  blocks: [], currentBlockId: null,
  // Legacy single-block fields — retained only for pre-multi-block migration on load.
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
const getPool = e => {
  if(e&&Array.isArray(e.pool)) return e.pool;
  const u=getUid(e); return u?[u]:[];
};
const inPool = (e,uid) => getPool(e).includes(uid);
const poolSize = e => getPool(e).length;
// Awarded entries carry a `source` tag indicating how they were filled, used for the post-block
// report. Tags: "pool" (single-claimant or contested winner), "cascade" (loser cascaded into the
// other open slot), "preferred-auto" (auto-filled on a date the winner had starred), "available-auto"
// (auto-filled on an available non-preferred date), "admin" (manual override). Legacy entries
// without a tag are treated as "unknown" so reports flag them rather than silently misattribute.
const getSource = e => {
  if(!e || !getUid(e)) return null;       // unfilled or pool-only
  if(e.source) return e.source;
  if(isAuto(e)) return "unknown-auto";    // pre-source-tag auto entries
  return "unknown-manual";                // pre-source-tag manual/pool entries
};
// Bidding: each pool member can bid points to win a contested slot. Stored as `entry.bids = {uid: bid}`.
// Legacy entries without a `bids` map default every member to bid 1 (preserves the old "winner loses 1 pt" rule).
const DEFAULT_BID = 1;
const getBid = (e, uid) => {
  if (e && e.bids && uid in e.bids) return e.bids[uid];
  return DEFAULT_BID;
};
const setEntryBid = (e, uid, bid) => {
  const bids = {...(e?.bids||{}), [uid]: bid};
  return {...(e||{pool:[],uid:null,auto:false}), bids};
};
const clearEntryBid = (e, uid) => {
  if (!e?.bids || !(uid in e.bids)) return e;
  const bids = {...e.bids}; delete bids[uid];
  return {...e, bids};
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
  if(cfg.blockStart && cfg.blockEnd) return { id:"legacy", name:"Block", start:cfg.blockStart, end:cfg.blockEnd, signupOpen:!!cfg.signupOpen };
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
  // { dateKey, penalty, projected } when the user is about to block past the allowed limit
  const [confirmBlockOver, setConfirmBlockOver] = useState(null);
  // Toggles the BlockReportModal (admin "Block report" action). The report itself is computed
  // on demand from current shifts, so we only need a boolean to drive open/close state.
  const [showBlockReport, setShowBlockReport] = useState(false);
  const [filterUid, setFilterUid] = useState(null);
  const [copied, setCopied] = useState(""); // SuperDashboard copy-to-clipboard feedback (hook must run on every render — Rules of Hooks)
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserForm, setAddUserForm] = useState({ name:"", username:"", email:"", role:"provider", seniorityId:"" });
  const [newUserResult, setNewUserResult] = useState(null); // { name, username, tempPassword, email } — shown after admin creates a user

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
        if(!Array.isArray(stored.blocks) || stored.blocks.length===0){
          const blocks = [];
          if(stored.blockStart && stored.blockEnd){
            blocks.push({
              id: Date.now(),
              name: "Block 1",
              start: stored.blockStart,
              end: stored.blockEnd,
              signupOpen: !!stored.signupOpen,
            });
          }
          stored.blocks = blocks;
          stored.currentBlockId = blocks.length ? blocks[0].id : null;
        }
        setConfig({...DEFAULT_CONFIG, ...stored});
      } else setConfig(DEFAULT_CONFIG);
    } catch{ setConfig(DEFAULT_CONFIG); }
    try { const r = await window.storage.get(gKey(gid,"shifts"),true).catch(()=>null); setShifts(r?JSON.parse(r.value):{}); } catch{ setShifts({}); }
    try {
      const r = await window.storage.get(gKey(gid,"unavail"),true).catch(()=>null);
      if(r){
        const raw=JSON.parse(r.value), mig={};
        Object.entries(raw).forEach(([uid,v])=>{ mig[uid]=Array.isArray(v)?Object.fromEntries(v.map(k=>[k,null])):(v||{}); });
        setUnavailability(mig);
      } else setUnavailability({});
    } catch{ setUnavailability({}); }
    try { const r = await window.storage.get(gKey(gid,"prefs"),true).catch(()=>null); setPreferences(r?JSON.parse(r.value):{}); } catch{ setPreferences({}); }
  };

  // Group-scoped persistence: writes under shyft_g{gid}_{key}. Root-level writes use persistRoot.
  const persist = async (key, val) => {
    if(!groupId){ /* called before a group is active — ignore to avoid leaking into root keys */ return; }
    try { await window.storage.set(gKey(groupId,key), JSON.stringify(val), true); } catch { flash("⚠️ Save failed"); }
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

  /* ── Super-admin helpers ── */
  const createGroup = async (name) => {
    const existingCodes = new Set(groups.flatMap(g=>[g.groupCode, g.adminCode]));
    let gc, ac;
    do { gc = genCode(6); } while(existingCodes.has(gc));
    do { ac = genCode(6); } while(existingCodes.has(ac) || ac===gc);
    const ng = { id:Date.now(), name:name.trim()||"Untitled group", groupCode:gc, adminCode:ac, createdAt:Date.now() };
    const next = [...groups, ng]; setGroups(next); await persistRoot("groups", next);
    flash(`✅ Group "${ng.name}" created`);
    return ng;
  };
  const deleteGroup = async (gid) => {
    const g = groups.find(x=>x.id===gid); if(!g) return;
    if(!confirm(`Delete group "${g.name}" and all of its data? This cannot be undone.`)) return;
    // Purge per-group keys
    for(const k of ["users","config","shifts","unavail","prefs"]){
      try { localStorage.removeItem("shyft_"+gKey(gid,k)); } catch{}
    }
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
    // Preferred-day check
    const pref = (preferences[uid]||[]).filter(d=>inBlock(d,config));
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
      for(const slot of config.shiftSlots){
        const e = day[slot.id];
        if(!e || !getUid(e)){
          if(e && poolSize(e) > 0) pendingPool++;
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

  const joinPool = async (dateKey, slotId) => {
    if (!me||me.role!=="provider") return;
    if (!currentBlock?.signupOpen) { flash("⚠️ Signup closed"); return; }
    if (!inBlock(dateKey,config)) { flash("⚠️ Outside block"); return; }
    if (!me.seniorityId) { flash("⚠️ Seniority not assigned yet"); return; }
    if (isUnavail(me.id,dateKey)) { flash("⚠️ You marked this day unavailable"); return; }
    const next={...shifts};
    if(!next[dateKey]) next[dateKey]={};
    const entry = next[dateKey][slotId] || {pool:[],uid:null,auto:false};
    if(entry.uid){ flash("⚠️ Slot already finalized"); return; }
    const pool = getPool(entry);
    const already = pool.includes(me.id);
    if(already){
      const np = pool.filter(u=>u!==me.id);
      if(np.length===0) delete next[dateKey][slotId];
      else {
        // Strip the leaver's bid as well so it doesn't linger.
        const stripped = clearEntryBid(entry, me.id);
        next[dateKey][slotId] = {...stripped, pool:np};
      }
      flash("Removed from pool");
    } else {
      const other = Object.entries(next[dateKey]).find(([sid,e])=>parseInt(sid)!==slotId&&inPool(e,me.id)&&!e.uid);
      if(other){ flash("⚠️ Leave the other slot pool for this day first"); return; }
      // Initial bid defaults to 1, capped at the user's current totalPts (so a broke user joins at 0).
      const cap = Math.max(0, Math.floor(totalPts(me.id)));
      const initialBid = Math.min(DEFAULT_BID, cap);
      const withMe = {...entry, pool:[...pool, me.id]};
      next[dateKey][slotId] = setEntryBid(withMe, me.id, initialBid);
      flash(`✅ You're in the pool (${pool.length+1} total) · bid ${initialBid} pt${initialBid===1?"":"s"}`);
    }
    if(!Object.keys(next[dateKey]).length) delete next[dateKey];
    setShifts(next); await persist("shifts",next);
    // Joining a pool implicitly stars the day as preferred — wanting a shift here means you'd take it.
    // (Leaving the pool does NOT auto-unstar; the user can manage the star independently afterwards.)
    if(!already){
      const pcur = preferences[me.id]||[];
      if(!pcur.includes(dateKey)){
        const pnext = {...preferences,[me.id]:[...pcur,dateKey]};
        setPreferences(pnext); await persist("prefs",pnext);
      }
    }
  };

  // Update the user's bid on a pool entry. Clamps to [0, floor(totalPts)] so they can't bid points they don't have.
  // No-op (with toast) if they're not in the pool, or if signup is closed, or if the slot has been finalized.
  const setBid = async (dateKey, slotId, rawAmount) => {
    if (!me || me.role !== "provider") return;
    if (!currentBlock?.signupOpen) { flash("⚠️ Signup closed"); return; }
    const entry = (shifts[dateKey]||{})[slotId];
    if (!entry) return;
    if (entry.uid) { flash("⚠️ Slot already finalized"); return; }
    if (!inPool(entry, me.id)) return;
    const cap = Math.max(0, Math.floor(totalPts(me.id)));
    const bid = Math.max(0, Math.min(cap, parseInt(rawAmount)||0));
    const next = {...shifts};
    next[dateKey] = {...next[dateKey], [slotId]: setEntryBid(entry, me.id, bid)};
    setShifts(next); await persist("shifts", next);
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
  };

  const toggleUnavail = async k => {
    if(!me||me.role!=="provider") return;
    const cur=unavailability[me.id]||{};
    const blocked=k in cur;
    if(!blocked){
      const hasWin=Object.values(shifts[k]||{}).some(e=>getUid(e)===me.id);
      if(hasWin){flash("⚠️ You're already awarded a shift this day");return;}
      const inAny=Object.values(shifts[k]||{}).some(e=>inPool(e,me.id)&&!getUid(e));
      if(inAny){flash("⚠️ Leave the pool for this day first");return;}
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
    const next={...preferences,[me.id]:wanted?cur.filter(d=>d!==k):[...cur,k]};
    setPreferences(next); await persist("prefs",next);
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
  const computeAutoAssign = () => {
    const result=JSON.parse(JSON.stringify(shifts));
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
  const computeReconcile = () => {
    const result = JSON.parse(JSON.stringify(shifts));
    const awarded = [];
    const deltas = {};
    const baseCache = {};
    const effPts = uid => {
      if(baseCache[uid]===undefined) baseCache[uid] = snapshotPtsForReconcile(uid);
      return baseCache[uid] + (deltas[uid]||0);
    };
    // Per-user awarded-shift counter. Seeded with any pre-existing awarded entries (e.g. from a
    // previous reconcile or admin manual assigns) so we don't double-count or re-fill above max.
    const perUserShifts = {};
    Object.values(result).forEach(day=>Object.values(day).forEach(e=>{const u=getUid(e); if(u) perUserShifts[u]=(perUserShifts[u]||0)+1;}));
    const maxOf = uid => {
      const u = users.find(x=>x.id===uid);
      return u?.targets?.max || 0;  // 0 = unset = no cap
    };
    const isAtMax = uid => { const m=maxOf(uid); return m>0 && (perUserShifts[uid]||0) >= m; };
    // Ranks pool by (bid desc, effPts desc, uid asc) AFTER filtering out at-max users.
    // Returns [] when nobody is eligible.
    const rankEligible = (entry, uids) => uids.filter(u=>!isAtMax(u)).sort((a,b)=>{
      const bidDiff = getBid(entry,b) - getBid(entry,a);
      if(bidDiff!==0) return bidDiff;
      const ptsDiff = effPts(b) - effPts(a);
      if(ptsDiff!==0) return ptsDiff;
      return a - b;
    });

    // Build the list of unfinalized pool slots, with cleaned eligibility, then sort by (size desc, date asc).
    // Cleaning: drop users who are unavailable that day, or already hold/are-pooled-for another slot
    // on the same day (so they don't get awarded both slots on a single date).
    const queue = [];
    for(const dateKey of blockDays){
      const day = result[dateKey];
      if(!day) continue;
      for(const slot of config.shiftSlots){
        const entry = day[slot.id];
        if(!entry) continue;
        if(getUid(entry)) continue;
        const cleanedPool = getPool(entry).filter(uid =>
          !isUnavail(uid,dateKey) &&
          !Object.entries(day).some(([sid,e])=>parseInt(sid)!==slot.id && getUid(e)===uid)
        );
        if(cleanedPool.length===0){ delete day[slot.id]; continue; }
        queue.push({ dateKey, slot, entry, cleanedPool });
      }
    }
    queue.sort((a,b) => (b.cleanedPool.length - a.cleanedPool.length) || a.dateKey.localeCompare(b.dateKey));

    for(const item of queue){
      const { dateKey, slot, entry } = item;
      const day = result[dateKey];
      if(!day || !day[slot.id]) continue;  // could have been cascaded into earlier in this loop
      // Re-filter against at-max state, since prior awards may have pushed users to their cap.
      const eligible = item.cleanedPool.filter(u => !isAtMax(u) &&
        !Object.entries(day).some(([sid,e])=>parseInt(sid)!==slot.id && getUid(e)===u));
      if(eligible.length===0){
        // Everyone in the pool either hit max elsewhere or got an other slot today via cascade.
        // The slot becomes openly unfilled (auto-assign will try later).
        delete day[slot.id];
        continue;
      }
      if(eligible.length===1){
        const only = eligible[0];
        day[slot.id] = {...entry, uid:only, auto:false, source:"pool"};
        perUserShifts[only] = (perUserShifts[only]||0)+1;
        awarded.push({dateKey,slot,winner:only,contested:false,pool:item.cleanedPool,bid:0,source:"pool"});
        continue;
      }
      const ranked = rankEligible(entry, eligible);
      if(ranked.length===0){ delete day[slot.id]; continue; }
      const best = ranked[0];
      // Cap bid at remaining effective points (snapshot minus already-spent bids in this reconcile).
      const winningBid = Math.max(0, Math.min(getBid(entry,best), Math.floor(effPts(best))));
      day[slot.id] = {...entry, uid:best, auto:false, source:"pool"};
      if (winningBid > 0) deltas[best] = (deltas[best]||0) - winningBid;
      perUserShifts[best] = (perUserShifts[best]||0)+1;
      awarded.push({dateKey,slot,winner:best,contested:true,pool:item.cleanedPool,bid:winningBid,source:"pool"});
      // Cascade losers (in ranked order) into any open slot on the same day, also respecting max.
      const losers = ranked.slice(1);
      for(const loser of losers){
        if(isAtMax(loser)) continue;
        if(Object.entries(day).some(([sid,e])=>parseInt(sid)!==slot.id&&(getUid(e)===loser||inPool(e,loser)))) continue;
        const emptySlot = config.shiftSlots.find(os=>os.id!==slot.id&&!day[os.id]);
        if(!emptySlot) break;
        day[emptySlot.id] = {pool:[loser],uid:loser,auto:false,source:"cascade"};
        perUserShifts[loser] = (perUserShifts[loser]||0)+1;
        awarded.push({dateKey,slot:emptySlot,winner:loser,contested:false,pool:[loser],cascaded:true,fromSlot:slot,bid:0,source:"cascade"});
      }
    }
    // Sweep: any day that ended up with no entries gets pruned.
    for(const dateKey of Object.keys(result)){
      if(!Object.keys(result[dateKey]).length) delete result[dateKey];
    }
    return { result, awarded, deltas };
  };

  const applyReconcile = async () => {
    if(!reconcilePreview) return;
    const { result, awarded, deltas } = reconcilePreview;
    setShifts(result); await persist("shifts",result);
    // Snapshot pointsAtClose for every provider BEFORE deducting bid spend, so future re-reconciles
    // (e.g. after admin reset+reclose) tiebreak against the same entering-block balance.
    const pointsAtClose = {};
    users.forEach(u => { if(u.role==="provider") pointsAtClose[u.id] = u.points || 0; });
    if(Object.keys(deltas).length){
      const nu = users.map(u=>deltas[u.id]?{...u,points:Math.max(0,(u.points||0)+deltas[u.id])}:u);
      setUsers(nu); await persist("users",nu);
    }
    // Stash the deltas on the current block so "Reset block" can reverse them.
    await updateCurrentBlock({signupOpen:false, lastReconcileDeltas:deltas, pointsAtClose});
    flash(`✅ ${awarded.length} shifts awarded · signup closed`);
    setReconcilePreview(null);
  };

  const resetBlock = async () => {
    // Clear all shifts within the current block, reopen signup, and
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
    // Reopening signup invalidates the entering-pts snapshot — fresh signup gets a fresh snapshot
    // when it next closes.
    await updateCurrentBlock({signupOpen:true, lastReconcileDeltas:{}, pointsAtClose:null});
    setConfirmReset(false);
    flash(`↺ Block reset · ${cleared} slot${cleared===1?"":"s"} cleared · signup reopened`);
  };

  /* ── Admin helpers ── */
  const updateConfig = async patch => { const next={...config,...patch}; setConfig(next); await persist("config",next); };
  // Patch the currently-active block in-place. No-op if no block is active.
  const updateCurrentBlock = async patch => {
    if(!config.currentBlockId || !Array.isArray(config.blocks)) return;
    const blocks = config.blocks.map(b => b.id===config.currentBlockId ? {...b, ...patch} : b);
    await updateConfig({blocks});
  };
  const adminAssign = async (dk,sid,uid) => {
    const next={...shifts}; if(!next[dk]) next[dk]={};
    if(uid===null){
      const prev=next[dk][sid]; const pool=prev?getPool(prev).filter(u=>u!==prev.uid):[];
      // Clearing the assignment leaves the (possibly empty) pool. Drop the source — it's open again.
      if(pool.length) next[dk][sid]={pool,uid:null,auto:false};
      else delete next[dk][sid];
    } else {
      const prev=next[dk][sid]||{}; const pool=Array.from(new Set([...getPool(prev),uid]));
      // Tag manual admin overrides distinctly so the block report can attribute them.
      next[dk][sid]={pool,uid,auto:false,source:"admin"};
    }
    if(!Object.keys(next[dk]).length) delete next[dk];
    setShifts(next); await persist("shifts",next); flash("Updated");
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
    return(
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 w-full max-w-sm p-7">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold text-lg">S</div>
            <h1 className="text-2xl font-semibold text-slate-900">Shyft</h1>
          </div>
          <p className="text-sm text-slate-500 mb-5">
            {authMode==="super"?"Create a new owner account. Existing owners sign in via the Sign in tab.":(noGroupsYet?"No groups yet — an owner must create one first.":"Sign in or join your group.")}
          </p>
          <div className="flex bg-slate-100 rounded-lg p-1 mb-5">
            {[["signin","Sign in"],["signup","Sign up"],["super","Owner"]].map(([m,l])=>(
              <button key={m} onClick={()=>{setAuthMode(m);setAuthError("");}}
                className={`flex-1 py-2 text-xs font-medium rounded-md transition ${authMode===m?"bg-white shadow text-slate-900":"text-slate-500"}`}>
                {l}
              </button>
            ))}
          </div>
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
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base font-mono focus:outline-none focus:border-blue-500" placeholder="Shyft-Kai-Dave"/></Field>
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
        </div>
        {toast&&<Toast msg={toast}/>}
      </div>
    );
  }

  /* ══ DAY SHEET ══ */
  const DaySheet = () => {
    if(!editingDay) return null;
    const date=parseDk(editingDay), dayShifts=shifts[editingDay]||{}, base=dayPts(date,config);
    const meUnavail=me.role==="provider"&&isUnavail(me.id,editingDay);
    const meHasShift=me.role==="provider"&&Object.values(dayShifts).some(e=>getUid(e)===me.id||inPool(e,me.id));
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

          {me.role==="provider"&&(
            <div className="px-4 pt-4 space-y-2">
              <div className="flex gap-2">
                <button onClick={()=>togglePreference(editingDay)} disabled={meUnavail}
                  className={`flex-1 py-2.5 px-3 text-sm font-medium rounded-lg ${isWanted(me.id,editingDay)?"bg-emerald-500 text-white hover:bg-emerald-600":"bg-slate-100 text-slate-700 hover:bg-slate-200"} ${meUnavail?"opacity-50 cursor-not-allowed":""}`}>
                  {isWanted(me.id,editingDay)?"⭐ Preferred date":"Prefer this date"}
                </button>
                <button onClick={()=>toggleUnavail(editingDay)} disabled={meHasShift&&!meUnavail}
                  className={`flex-1 py-2.5 px-3 text-sm font-medium rounded-lg ${meUnavail?"bg-red-500 text-white hover:bg-red-600":"bg-slate-100 text-slate-700 hover:bg-slate-200"} ${meHasShift&&!meUnavail?"opacity-50 cursor-not-allowed":""}`}>
                  {meUnavail?"🚫 Blocked":"Block this day"}
                </button>
              </div>
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
              const pool=getPool(entry), pSize=pool.length;
              const meInPool=me.role==="provider"&&!winnerUid&&pool.includes(me.id);
              const othersInPool=winnerUid?0:(meInPool?pSize-1:pSize);
              return(
                <div key={slot.id} className="border-2 rounded-xl p-3" style={{borderColor:winner?slot.color:(pSize>0?"#CBD5E1":"#E2E8F0")}}>
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
                    ):pSize>0?(
                      <span className="text-xs font-medium bg-slate-100 text-slate-700 px-2 py-1 rounded-full">{pSize} in pool</span>
                    ):<span className="text-sm text-slate-400">No pool yet</span>}
                  </div>

                  {me.role==="provider"&&meInPool&&!winner&&(()=>{
                    const myBid = getBid(entry, me.id);
                    const cap = Math.max(0, Math.floor(totalPts(me.id)));
                    return(
                      <div className="bg-brand-50 border border-brand-200 rounded-xl p-3 mb-2 space-y-2.5">
                        <div className="text-xs text-brand-900 leading-relaxed">
                          You're in the pool for this shift.{othersInPool>0?` ${othersInPool} other ${othersInPool===1?"person is":"people are"} too.`:" You're the only one so far."}
                        </div>
                        {/* Bid stepper — set how many points you'll spend if you win the tie-break */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-brand-700">Tie-break bid</div>
                            <div className="text-[10px] text-ink-500 mt-0.5">Cost if you win · max <span className="font-bold tabular-nums">{cap}</span> pt{cap===1?"":"s"}</div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button type="button" onClick={()=>setBid(editingDay, slot.id, myBid-1)} disabled={myBid<=0}
                              aria-label="Decrease bid"
                              className="w-7 h-7 rounded-lg bg-white border border-brand-200 hover:bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed transition">−</button>
                            <input type="number" min="0" max={cap} value={myBid}
                              onChange={e=>{ const n=parseInt(e.target.value); if(!isNaN(n)) setBid(editingDay, slot.id, n); }}
                              className="v2-num-input w-14 px-1 py-0.5 text-2xl font-extrabold tabular-nums text-center bg-white outline-none border border-brand-200 focus:border-brand-400 rounded-lg text-brand-700"/>
                            <button type="button" onClick={()=>setBid(editingDay, slot.id, myBid+1)} disabled={myBid>=cap}
                              aria-label="Increase bid"
                              className="w-7 h-7 rounded-lg bg-white border border-brand-200 hover:bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-base leading-none disabled:opacity-30 disabled:cursor-not-allowed transition">+</button>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  {me.role==="provider"&&!meInPool&&!winner&&pSize>0&&(
                    <div className="bg-slate-50 rounded-lg p-2.5 mb-2 text-xs text-slate-600">
                      {pSize} {pSize===1?"person is":"people are"} in the pool for this shift.
                    </div>
                  )}

                  {me.role==="provider"&&(
                    winner?(
                      <div className={`w-full py-2.5 text-sm rounded-lg font-medium text-center ${isMineWinner?"bg-green-100 text-green-800":"bg-slate-100 text-slate-500"}`}>
                        {isMineWinner?"✓ Awarded to you":"Awarded"}
                      </div>
                    ):(()=>{
                      const outOfBlock=!inBlock(editingDay,config);
                      const disabledReason =
                        outOfBlock ? "This date isn't in the current signup block." :
                        !currentBlock?.signupOpen ? "Signup is closed — wait for the admin to open it." :
                        !me.seniorityId ? "Your seniority hasn't been assigned yet — ask an admin." :
                        meUnavail ? "You marked this day as blocked — unblock it to join." :
                        null;
                      return(<>
                        <button onClick={()=>joinPool(editingDay,slot.id)}
                          disabled={!!disabledReason}
                          className={`w-full py-2.5 text-sm rounded-lg font-medium transition ${
                            meInPool?"bg-slate-100 text-slate-700 hover:bg-slate-200":
                            "bg-blue-600 text-white hover:bg-blue-700"
                          } ${disabledReason?"opacity-50 cursor-not-allowed":""}`}>
                          {meUnavail?"Unavailable":meInPool?"Leave pool":"Join pool for this shift"}
                        </button>
                        {disabledReason&&<div className="mt-1.5 text-[11px] text-slate-500 italic">{disabledReason}</div>}
                      </>);
                    })()
                  )}
                  {me.role==="admin"&&(
                    <div className="space-y-1.5">
                      <select value={winnerUid||""} onChange={e=>adminAssign(editingDay,slot.id,e.target.value?parseInt(e.target.value):null)}
                        className="w-full text-sm border border-slate-300 rounded-lg px-2 py-2 bg-white">
                        <option value="">— Open / pool-only —</option>
                        {users.filter(u=>u.role==="provider"&&u.seniorityId).map(u=>{
                          const un=isUnavail(u.id,editingDay);
                          return <option key={u.id} value={u.id} disabled={un}>{u.name}{un?" (unavailable)":""}{pool.includes(u.id)?" · in pool":""}</option>;
                        })}
                      </select>
                      {pSize>0&&!winner&&<div className="text-[11px] text-slate-500">Pool: {pool.map(uid=>users.find(u=>u.id===uid)?.name.split(" ")[0]||"?").join(", ")}</div>}
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
            <div className="font-semibold text-xl">Close & reconcile</div>
            {(()=>{
              const totalBid = contested.reduce((s,a)=>s+(a.bid||0),0);
              return <p className="text-sm text-slate-500 mt-1">{awarded.length} slots awarded · {contested.length} contested · {cascaded.length} cascaded · {totalBid} bid pt{totalBid===1?"":"s"} spent</p>;
            })()}
          </div>
          <div className="overflow-y-auto p-5 flex-1 space-y-4">
            {contested.length>0&&(
              <div>
                <div className="text-sm font-medium text-slate-700 mb-2">Contested (pool {`>`} 1) — winning bid charged</div>
                <div className="space-y-1.5">{contested.map((a,i)=>{
                  const d=parseDk(a.dateKey), w=users.find(u=>u.id===a.winner);
                  const bid=a.bid||0;
                  return(
                    <div key={i} className="flex items-center gap-2 text-sm py-1">
                      <span className="text-slate-500 w-20 flex-shrink-0">{MONTHS_SHORT[d.getMonth()]} {d.getDate()} {DAYS_SHORT[d.getDay()]}</span>
                      <span className="font-medium text-xs px-2 py-0.5 rounded" style={{background:a.slot.color+"20",color:a.slot.color}}>{a.slot.name}</span>
                      <span className="text-xs text-slate-500">pool {a.pool.length}</span>
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
            {awarded.length===0&&<p className="text-sm text-slate-500 text-center py-4">No pool entries to reconcile.</p>}
          </div>
          <div className="p-4 border-t border-slate-100 flex gap-2">
            <button onClick={()=>setReconcilePreview(null)} className="flex-1 py-2.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-lg font-medium">Cancel</button>
            <button onClick={applyReconcile} className="flex-1 py-2.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">Close signup & apply</button>
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
                {currentBlock?.name || "Block"} · {filledCount}/{totalSlots} filled · {openSlots} open · {pendingPool} pending pool
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
                  ⚠️ {pendingPool} pool slot{pendingPool===1?" is":"s are"} still pending — close & reconcile to award.
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
                        <th className="text-right py-2 px-1.5" title="Pool wins">Pool</th>
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
    let slotCount = 0, poolCount = 0;
    for(const k of blockDays){
      const day = shifts[k]; if(!day) continue;
      for(const s of config.shiftSlots){
        const e = day[s.id]; if(!e) continue;
        if(getUid(e)) slotCount++;
        else if(poolSize(e)>0) poolCount++;
      }
    }
    const deltaCount = Object.keys(config.lastReconcileDeltas||{}).length;
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setConfirmReset(false)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="text-2xl mb-2">↺</div>
          <div className="font-semibold text-xl mb-2">Reset block?</div>
          <p className="text-sm text-slate-600 mb-3">This will clear everything on the calendar for the current block and reopen signup so you can run assignments again.</p>
          <ul className="text-sm text-slate-700 space-y-1 mb-4 list-disc list-inside">
            <li><span className="font-medium">{slotCount}</span> awarded slot{slotCount===1?"":"s"} will be cleared.</li>
            <li><span className="font-medium">{poolCount}</span> pending pool{poolCount===1?"":"s"} will be cleared.</li>
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

  // Admin-only: form for adding a new user to the current group with a generated temp password.
  const AddUserModal = () => {
    if(!addUserOpen) return null;
    return(
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setAddUserOpen(false)}>
        <div className="bg-white rounded-2xl max-w-md w-full p-5" onClick={e=>e.stopPropagation()}>
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-xl">Add user</div>
            <button onClick={()=>setAddUserOpen(false)} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:bg-slate-100 rounded-full text-xl leading-none">×</button>
          </div>
          <p className="text-sm text-slate-500 mb-4">We'll generate a temporary password you can share. They can sign in with their username and the temp password right away.</p>
          <Field label="Full name"><input type="text" value={addUserForm.name}
            onChange={e=>setAddUserForm({...addUserForm,name:e.target.value})}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="Jane Smith"/></Field>
          <Field label="Username"><input type="text" value={addUserForm.username} autoCapitalize="none"
            onChange={e=>setAddUserForm({...addUserForm,username:e.target.value})}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="jsmith"/></Field>
          <Field label="Email (optional — used to prefill the email share)"><input type="email" value={addUserForm.email}
            onChange={e=>setAddUserForm({...addUserForm,email:e.target.value})}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="jane@example.com"/></Field>
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
          <button onClick={async()=>{
              const result = await adminAddUser(addUserForm);
              if(result.error){ flash("⚠️ " + result.error); return; }
              setNewUserResult({
                name: result.user.name,
                username: result.user.username,
                tempPassword: result.tempPassword,
                email: result.user.email,
                role: result.user.role,
              });
              setAddUserOpen(false);
              setAddUserForm({ name:"", username:"", email:"", role:"provider", seniorityId:"" });
            }}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-sm font-medium">
            Generate account
          </button>
        </div>
      </div>
    );
  };

  // Shown after adminAddUser succeeds. Displays username + temp password with copy / email share helpers.
  const NewUserInfoModal = () => {
    if(!newUserResult) return null;
    const { name, username, tempPassword, email, role } = newUserResult;
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
    const mailto = `mailto:${email||""}?subject=${encodeURIComponent("Your Shyft login")}&body=${encodeURIComponent(body)}`;
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
            <p><span className="font-semibold text-slate-900">3. Join pools for specific shifts.</span> On the Calendar / Shifts page, tap a day and join the pool for any slot you want. You'll see how many others are in the pool too. Joining defaults you to a <span className="font-semibold text-slate-900">1-point bid</span>; bid higher (up to your current points) if you really want it.</p>
            <p><span className="font-semibold text-slate-900">4. Block what you can't.</span> Optionally classify (Working, Vacation, Conference, Personal Conflict). You may block up to {config.maxBlockedDays} days ({config.maxBlockedWeekendDays} weekend) — going over costs a point per extra day. You also need to prefer at least {config.minPreferredDays} days ({config.minPreferredWeekendDays} weekend) or lose points.</p>
            <p><span className="font-semibold text-slate-900">5. Settled at close.</span> When the admin closes the window, contested slots go to the <span className="font-semibold text-slate-900">highest bidder</span> (ties fall to highest current points). The winner pays their winning bid. One-claimant slots are auto-awarded for free.</p>
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
            const poolN=Object.values(dayS).reduce((a,e)=>a+(getUid(e)?0:poolSize(e)),0);
            const myUn=me.role==="provider"&&isUnavail(me.id,key);
            const myWant=me.role==="provider"&&isWanted(me.id,key);
            const myShift=me.role==="provider"&&awarded.some(x=>x.uid===me.id);
            const myPool=me.role==="provider"&&!myShift&&Object.values(dayS).some(e=>!getUid(e)&&inPool(e,me.id));
            // When filter is on, check if the selected user is on this day.
            const filterHit=filterUid?awarded.some(x=>x.uid===filterUid)||Object.values(dayS).some(e=>!getUid(e)&&inPool(e,filterUid)):false;
            const dimmed=filterUid&&inB&&!filterHit;
            // Calendar cell background gradient: low → high point value. Red is reserved
            // for blocked days only (strong "don't schedule here" signal); deeper amber
            // carries the "more points" intuition for live days.
            const bg=!inB?"bg-slate-50":myUn?"bg-red-100":hol?"bg-green-100":pts===0?"bg-blue-50":pts===1?"bg-blue-100":pts===2?"bg-amber-100":pts===3?"bg-amber-200":"bg-amber-300";
            // Admin-only post-reconcile overlays. Challenging (hard-to-fill) days get the strongest
            // ring; auto-only-ish days get a subtler gear marker. Provider rings (award/pool) still win.
            const insights = dayInsights(key);
            const adminChallenging = !!insights?.challenging;
            const adminHasAuto = !!insights?.hasAuto;
            // Ring: highlight filter match in purple, else show your own award/pool rings, else admin challenge ring.
            const ring=filterUid?(filterHit?"ring-2 ring-purple-500":""):(myShift?"ring-2 ring-green-500":myPool?"ring-2 ring-blue-400":adminChallenging?"ring-2 ring-orange-500":"");
            // A provider can join a pool from this cell if signup is open, they have seniority,
            // they aren't blocked themselves, and the slot isn't already won by someone.
            const provCanJoin = me.role==="provider" && !!currentBlock?.signupOpen && !!me.seniorityId && !myUn;
            // Star/X are inline next to the date for fast preferred/blocked toggling.
            // Outer cell is a <div role=button> so we can nest real <button> elements legally.
            return(
              <div key={key} role={inB?"button":undefined} tabIndex={inB?0:-1} aria-disabled={!inB}
                className={`aspect-square rounded-lg p-1 sm:p-1.5 flex flex-col text-[10px] ${bg} ${inB?"active:scale-95 hover:ring-2 hover:ring-blue-400 cursor-pointer":"opacity-40 cursor-default"} ${ring} ${dimmed?"opacity-30":""}`}
                onClick={()=>inB&&setEditingDay(key)}
                onKeyDown={inB?(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault(); setEditingDay(key);}}:undefined}>
                <div className="flex items-center justify-between leading-none gap-0.5">
                  <span className="font-semibold text-slate-700 text-xs flex items-center gap-0.5 min-w-0">
                    {adminChallenging&&<span className="text-orange-600" title="Hard to fill — nobody preferred, most blocked, all slots auto-assigned">⚠</span>}
                    <span>{d}</span>
                    {/* Inline star — outlined when not preferred, filled when preferred. Hidden on blocked
                        or already-awarded days (preference is moot). Provider only. */}
                    {me.role==="provider"&&inB&&!myUn&&!myShift&&(
                      <button type="button" onClick={(e)=>{e.stopPropagation(); togglePreference(key);}}
                        title={myWant?"Preferred · click to unmark":"Mark preferred"}
                        className={`leading-none text-[12px] sm:text-[13px] ${myWant?"text-emerald-500":"text-slate-300 hover:text-emerald-500"}`}>
                        {myWant?"★":"☆"}
                      </button>
                    )}
                    {/* Inline X — toggle blocked. Hidden once user has a winning shift on this day. */}
                    {me.role==="provider"&&inB&&!myShift&&(
                      <button type="button" onClick={(e)=>{e.stopPropagation(); toggleUnavail(key);}}
                        title={myUn?"Blocked · click to unblock":"Block this day"}
                        className={`leading-none text-[10px] sm:text-[11px] font-bold ${myUn?"text-red-600":"text-slate-300 hover:text-red-500"}`}>
                        ✕
                      </button>
                    )}
                  </span>
                  <span className="flex items-center gap-0.5 flex-shrink-0">
                    {adminHasAuto&&!adminChallenging&&<span className="text-[9px] text-amber-600" title="Contains auto-assigned slots">⚙</span>}
                    {pts>0&&<span className="text-[9px] text-slate-500">+{pts}</span>}
                  </span>
                </div>
                {hol&&<div className="text-[8px] text-green-800 truncate leading-tight mt-0.5">{hol}</div>}
                {!inB?null:myUn?(
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-[10px] sm:text-[11px] font-bold text-red-700">✕ BLOCKED</span>
                  </div>
                ):(
                  // Centered, per-slot chips — for providers with no winner yet, these become real
                  // pool-join buttons (stopPropagation so they don't also open the day sheet).
                  // Awarded slots stay solid-colored with the assignee's name (non-interactive).
                  <div className="flex-1 flex flex-col justify-center w-full gap-0.5 overflow-hidden py-0.5">
                    {config.shiftSlots.map(s=>{
                      const entry=dayS[s.id];
                      const winUid=getUid(entry), u=winUid?users.find(uu=>uu.id===winUid):null;
                      const isMe=winUid===me.id, isFilt=filterUid&&winUid===filterUid, auto=isAuto(entry);
                      const pSize=poolSize(entry);
                      const meIn=me.role==="provider"&&!winUid&&inPool(entry,me.id);
                      const filtInPool=filterUid&&!winUid&&inPool(entry,filterUid);
                      if(u) return(
                        <div key={s.id}
                          className={`text-[9px] sm:text-[10px] px-1 py-0.5 rounded leading-tight truncate font-medium ${isMe?"bg-green-100 text-green-800":isFilt?"bg-purple-100 text-purple-800":"text-white"}`}
                          style={!isMe&&!isFilt?{background:s.color}:{}} title={`${s.name}: ${u.name}${auto?" (auto)":""}`}>
                          {u.name.split(" ")[0]}{auto?" ⚙":""}
                        </div>
                      );
                      const poolCls = `text-[9px] sm:text-[10px] px-1 py-0.5 rounded leading-tight truncate font-semibold border ${meIn?"bg-blue-100 text-blue-800 border-blue-300":filtInPool?"bg-purple-100 text-purple-800 border-purple-300":"bg-white border-slate-300 text-slate-700"} ${provCanJoin?"hover:brightness-95":""}`;
                      if(pSize>0) {
                        return provCanJoin ? (
                          <button key={s.id} type="button" onClick={(e)=>{e.stopPropagation(); joinPool(key, s.id);}}
                            className={poolCls}
                            title={meIn?`${s.name}: leave pool`:`${s.name}: join pool of ${pSize}`}>
                            {meIn?`★ You +${pSize-1}`:`${s.name} · ${pSize}`}
                          </button>
                        ) : (
                          <div key={s.id} className={poolCls} title={`${s.name}: pool of ${pSize}`}>
                            {meIn?`You +${pSize-1}`:`${s.name} · ${pSize}`}
                          </div>
                        );
                      }
                      return provCanJoin ? (
                        <button key={s.id} type="button" onClick={(e)=>{e.stopPropagation(); joinPool(key, s.id);}}
                          className="text-[9px] sm:text-[10px] px-1 py-0.5 rounded leading-tight truncate font-bold bg-white hover:brightness-95"
                          style={{border:`1.5px solid ${s.color}`, color:s.color}}
                          title={`${s.name}: join pool`}>
                          {s.name}
                        </button>
                      ) : (
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
          {me.role==="provider"&&<Legend ring="ring-2 ring-blue-400" label="In pool"/>}
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
          return Object.values(day).some(e=>getUid(e)===filterUid || inPool(e,filterUid));
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
                    const pSize=poolSize(entry), meIn=me.role==="provider"&&!winUid&&inPool(entry,me.id);
                    if(u) return(
                      <span key={s.id} className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${isMe?"bg-green-100 text-green-800":"text-white"}`}
                        style={!isMe?{background:s.color}:{}}>
                        {s.name}: {isMe?"You":u.name.split(" ")[0]}{auto?" ⚙":""}
                      </span>
                    );
                    if(pSize>0) return(
                      <span key={s.id} className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border-2 ${meIn?"bg-blue-100 text-blue-800 border-blue-300":"bg-white text-slate-700 border-slate-300"}`}>
                        {s.name}: {meIn?`You + ${pSize-1}`:`Pool ${pSize}`}
                      </span>
                    );
                    return <span key={s.id} className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-white border-2"
                      style={{borderColor:s.color, color:s.color}}>
                      {s.name}: Open
                    </span>;
                  })}
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
      {!avail.meets&&currentBlock&&(
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-3 text-sm">
          <div className="font-medium text-red-900 mb-1">⚠️ Availability shortfall</div>
          <div className="text-red-800 text-xs">
            {avail.dayShort>0&&<>Need {avail.dayShort} more available day(s). </>}
            {avail.wkShort>0&&<>Need {avail.wkShort} more weekend day(s). </>}
            <span className="font-semibold">Penalty: −{avail.penalty} pts.</span>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-5">
        <Stat label="Total pts" value={total.toFixed(total%1?1:0)} color={total<0?"text-red-600":"text-amber-600"}/>
        <Stat label="Shifts" value={`${count}/${min||"—"}`} color="text-blue-600"/>
        <Stat label="Available" value={`${avail.availD}/${blockDays.length||"—"}`} color={avail.meets?"text-green-600":"text-red-600"}/>
      </div>
      {currentBlock&&(
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3">
          <div className="text-sm font-semibold mb-1">{currentBlock.name||"This block"}</div>
          <p className="text-sm text-slate-600">{MONTHS_SHORT[parseDk(currentBlock.start).getMonth()]} {parseDk(currentBlock.start).getDate()} → {MONTHS_SHORT[parseDk(currentBlock.end).getMonth()]} {parseDk(currentBlock.end).getDate()}</p>
          <p className="text-sm mt-1">Signup is {currentBlock.signupOpen?<span className="text-green-700 font-medium">open</span>:<span className="text-slate-700 font-medium">closed</span>}.</p>
        </div>
      )}
      <div>
        <button onClick={()=>setPage("schedule")} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-medium text-sm">Open schedule →</button>
      </div>
    </>);
  };

  const AdminHome = () => {
    const provs=users.filter(u=>u.role==="provider"), unassigned=provs.filter(u=>!u.seniorityId);
    let assigned=0, pendingPool=0, contested=0;
    Object.values(shifts).forEach(d=>Object.values(d).forEach(e=>{
      if(getUid(e)) assigned++;
      else { pendingPool++; if(poolSize(e)>1) contested++; }
    }));
    const totalSlots=blockDays.length*config.shiftSlots.length, open=totalSlots-assigned-pendingPool;
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
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3 mb-5">
        <Stat label="Providers" value={provs.length} color="text-blue-600"/>
        <Stat label="Awarded" value={totalSlots?`${assigned}/${totalSlots}`:"—"} color={assigned===totalSlots?"text-green-600":"text-amber-600"} small/>
        <Stat label="In pool" value={pendingPool} color={pendingPool>0?"text-blue-600":"text-slate-400"}/>
        {/* Per the spec, open-shifts-remaining is a first-class dashboard metric. */}
        <Stat label="Open" value={open} color={open===0?"text-green-600":open>0?"text-red-600":"text-slate-400"}/>
        <Stat label="Signup" value={currentBlock?.signupOpen?"Open":"Closed"} color={currentBlock?.signupOpen?"text-green-600":"text-slate-500"}/>
      </div>
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3">
        <div className="font-semibold mb-3">Quick actions</div>
        <div className="grid grid-cols-2 gap-2">
          {currentBlock?.signupOpen?
            <button onClick={()=>setReconcilePreview(computeReconcile())} disabled={pendingPool===0}
              className="py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40">
              {pendingPool===0?"No pools to reconcile":`Close & reconcile (${pendingPool})`}
            </button>
            :<button onClick={()=>updateCurrentBlock({signupOpen:true})} disabled={!currentBlock}
              className="py-2.5 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-40">
              {currentBlock?"Open signup":"No block selected"}
            </button>
          }
          <button onClick={()=>setAutoPreview(computeAutoAssign())} disabled={totalSlots-assigned===0}
            className="py-2.5 text-sm font-medium rounded-lg bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40">
            {totalSlots-assigned===0?"All filled ✓":`Auto-fill ${totalSlots-assigned} leftover`}
          </button>
          <button onClick={()=>setShowBlockReport(true)} disabled={!currentBlock||totalSlots===0}
            className="py-2.5 text-sm border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-40 font-medium">
            📊 Block report
          </button>
          <button onClick={()=>setPage("setup")} className="py-2.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">Setup</button>
          <button onClick={()=>setPage("people")} className="py-2.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50">People</button>
        </div>
        {contested>0&&<p className="text-[11px] text-slate-500 mt-2">{contested} contested slot{contested===1?"":"s"} in pool — reconcile awards to the highest bidder (ties break on current points). Winner pays their bid.</p>}
        {(assigned>0||pendingPool>0)&&(
          <div className="mt-3 pt-3 border-t border-slate-100">
            <button onClick={()=>setConfirmReset(true)} className="w-full py-2 text-xs font-medium rounded-lg border border-red-200 text-red-700 hover:bg-red-50">
              ↺ Reset block
            </button>
            <p className="text-[11px] text-slate-500 mt-1.5">Clears all awards and pools for this block and reopens signup. Refunds any winning bids charged in the last reconcile. Keeps availability, preferences, and targets.</p>
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
        {me.role==="admin"?"Tap any day to assign.":!me.seniorityId?"Admin must assign your seniority.":currentBlock?.signupOpen?"Tap a day to sign up.":"Signup closed — view only."}
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
    // Status-report extras: total points and # of slots they're currently in the pool for (no winner yet).
    const myPoints = totalPts(me.id);
    const myPoolCount = blockDays.reduce((acc, k) => {
      const dayS = shifts[k] || {};
      for (const s of config.shiftSlots) {
        const entry = dayS[s.id];
        if (!getUid(entry) && inPool(entry, me.id)) acc++;
      }
      return acc;
    }, 0);
    const statusOk = avail.meets;
    // Headline color reflects overall pass/fail
    const statusText = statusOk ? "text-emerald-600" : "text-amber-600";
    return(<>
      {/* Hero */}
      <div className="mb-6 sm:mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-brand-700 leading-tight tracking-tight">Schedule</h1>
        <p className="text-sm sm:text-base text-ink-500 mt-2 max-w-2xl leading-relaxed">
          Mark the days you prefer, block the ones you can't work, and join the pool for specific shifts.
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
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-500">In pool for</div>
            <div className="flex items-baseline gap-1.5 mt-0.5 leading-none">
              <span className={`text-2xl sm:text-3xl font-extrabold tabular-nums ${myPoolCount>0?"text-emerald-600":"text-ink-400"}`}>{myPoolCount}</span>
              <span className="text-xs font-semibold text-ink-500">shift{myPoolCount===1?"":"s"}</span>
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
              {blockDays.length} day{blockDays.length===1?"":"s"} · signup <span className={currentBlock?.signupOpen?"text-emerald-600 font-semibold":"text-ink-500 font-semibold"}>{currentBlock?.signupOpen?"open":"closed"}</span>
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

  // v2 ScheduleList — redesigned day cards: date tile + slot chips + 3-state segmented control
  // (Preferred / Available / Blocked). Tapping the card header still opens DaySheet for pool/slot actions.
  const ScheduleList = () => (
    <div className="space-y-3">{blockDays.map(k=>{
      const date=parseDk(k), blocked=isUnavail(me.id,k), reason=unavailReason(me.id,k);
      const wanted=isWanted(me.id,k), dayS=shifts[k]||{}, hasShift=Object.values(dayS).some(e=>getUid(e)===me.id);
      const isWk=isWeekend(k), pts=dayPts(date,config), hol=config.holidays[k];
      const filled=Object.values(dayS).filter(e=>getUid(e)).length, total=config.shiftSlots.length;
      const available = !blocked && !wanted;
      // Segmented state setters: clicking a pill normalizes to that state (clearing mutually exclusive ones).
      const setPreferred = () => { if(blocked) toggleUnavail(k); if(!wanted) togglePreference(k); };
      const setAvailable = () => { if(blocked) toggleUnavail(k); if(wanted) togglePreference(k); };
      const setBlocked   = () => { if(hasShift && !blocked) return; if(wanted) togglePreference(k); if(!blocked) toggleUnavail(k); };
      // Point pill — deeper amber as pts climb; brand-blue for 1pt weekdays; neutral for 0-pt.
      const pillBg = pts===0?"bg-slate-100 text-ink-500":pts===1?"bg-brand-50 text-brand-700":pts===2?"bg-amber-100 text-amber-800":pts===3?"bg-amber-200 text-amber-900":"bg-amber-300 text-amber-900";
      const cardFrame = blocked
        ? "bg-red-50/60 border-red-200"
        : hasShift
          ? "bg-surface ring-2 ring-emerald-400 border-transparent"
          : wanted
            ? "bg-emerald-50/40 border-emerald-200"
            : "bg-surface border-slate-200";
      const tileBg = blocked?"bg-red-100":wanted?"bg-emerald-100":hasShift?"bg-emerald-50":"bg-slate-50";
      const tileText = blocked?"text-red-700":wanted?"text-emerald-700":"text-ink-900";
      const tileDow = blocked?"text-red-600":wanted?"text-emerald-700":"text-ink-500";
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
                {wanted && <span className="text-emerald-500 text-sm leading-none" title="Preferred">⭐</span>}
                {pts>0 && <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${pillBg}`}>+{pts} pt{pts>1?"s":""}</span>}
                {isWk && <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-medium">Weekend</span>}
                {hol && <span className="text-[10px] bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-full font-medium">{hol}</span>}
                {blocked && <span className="text-[10px] bg-red-100 text-red-800 border border-red-200 px-2 py-0.5 rounded-full font-bold">✕ Blocked{reason?` · ${reason}`:""}</span>}
                {hasShift && <span className="text-[10px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded-full font-bold">✓ You're on</span>}
              </div>
              <div className="flex flex-wrap gap-1">
                {config.shiftSlots.map(s=>{
                  const entry=dayS[s.id], winUid=getUid(entry), u=winUid?users.find(x=>x.id===winUid):null;
                  const isMe=winUid===me.id, auto=isAuto(entry);
                  const pSize=poolSize(entry), meIn=!winUid&&inPool(entry,me.id);
                  if(u) return(
                    <span key={s.id} className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${isMe?"bg-emerald-100 text-emerald-800":"text-white"}`}
                      style={!isMe?{background:s.color}:{}}>
                      {s.name}: {isMe?"You":u.name.split(" ")[0]}{auto?" ⚙":""}
                    </span>
                  );
                  if(pSize>0) return(
                    <span key={s.id} className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border-2 ${meIn?"bg-brand-50 text-brand-700 border-brand-200":"bg-white text-ink-700 border-slate-300"}`}>
                      {s.name}: {meIn?`You +${pSize-1}`:`Pool ${pSize}`}
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
          {/* Two stacked rows of segmented controls:
                Row 1 — pool-join pills (one per slot), prominent, sized to match Row 2
                Row 2 — 3-state Preferred / Available / Blocked
              Visually paired so the user reads "what shift?" then "what kind of day?". */}
          <div className="px-4 pb-4 space-y-2">
            <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
              {config.shiftSlots.map(s=>{
                const entry=dayS[s.id], winUid=getUid(entry);
                const u=winUid?users.find(x=>x.id===winUid):null;
                const isMine=winUid===me.id, meIn=!winUid&&inPool(entry,me.id), pSize=poolSize(entry);
                const lockReason = blocked ? "You blocked this day"
                  : !currentBlock?.signupOpen ? "Signup is closed"
                  : !me.seniorityId ? "Seniority not assigned"
                  : (winUid && !isMine) ? `Awarded to ${u?.name.split(" ")[0]||"another"}`
                  : null;
                const locked = !!lockReason;
                // Each pill carries the slot's color even when not active: solid fill when joined/awarded,
                // white-with-colored-border when joinable. That keeps every button visually distinct
                // (no longer reads as one continuous strip) while sharing size with the row below.
                let label, btnCls = "", btnStyle;
                if (isMine) { label = `✓ ${s.name}`; btnCls = "text-white shadow-sm border-[1.5px]"; btnStyle = {background:s.color, borderColor:s.color}; }
                else if (u) { label = `${s.name} · ${u.name.split(" ")[0]}`; btnCls = "text-white border-[1.5px]"; btnStyle = {background:s.color, borderColor:s.color}; }
                else if (meIn) { label = `★ ${s.name}${pSize>1?` +${pSize-1}`:""}`; btnCls = "text-white shadow-sm border-[1.5px]"; btnStyle = {background:s.color, borderColor:s.color}; }
                else if (locked) { label = `Join ${s.name} pool${pSize>0?` · ${pSize}`:""}`; btnCls = "bg-white border-[1.5px] border-slate-200 text-ink-400"; }
                else { label = `Join ${s.name} pool${pSize>0?` · ${pSize}`:""}`; btnCls = "bg-white border-[1.5px] shadow-sm hover:brightness-95"; btnStyle = {borderColor:s.color, color:s.color}; }
                return (
                  <button key={s.id} type="button" onClick={()=>!locked&&joinPool(k,s.id)} disabled={locked} title={lockReason||""}
                    style={btnStyle}
                    className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition truncate ${btnCls} ${locked?"opacity-50 cursor-not-allowed":""}`}>
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
              <button onClick={setPreferred}
                className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${wanted?"bg-emerald-500 text-white shadow-sm":"text-ink-500 hover:text-emerald-700"}`}>
                ⭐ Preferred
              </button>
              <button onClick={setAvailable}
                className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${available?"bg-brand-600 text-white shadow-sm":"text-ink-500 hover:text-brand-700"}`}>
                Available
              </button>
              <button onClick={setBlocked} disabled={hasShift && !blocked}
                className={`flex-1 text-[11px] font-bold py-2 px-2 rounded-lg transition ${blocked?"bg-red-500 text-white shadow-sm":"text-ink-500 hover:text-red-600"} ${hasShift && !blocked?"opacity-40 cursor-not-allowed":""}`}>
                ✕ Blocked
              </button>
            </div>
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
        </div>
      );
    })}</div>
  );

  const MyShiftsPage = () => {
    const mine=[], pending=[];
    Object.entries(shifts).sort().forEach(([k,day])=>{
      Object.entries(day).forEach(([sid,e])=>{
        const slot=config.shiftSlots.find(s=>s.id===parseInt(sid)), date=parseDk(k);
        if(getUid(e)===me.id){
          const pts=dayPts(date,config)*(slot?.credit||1);
          const nonPref=isAuto(e)&&!(preferences[me.id]||[]).includes(k);
          mine.push({k,date,slot,pts,auto:isAuto(e),nonPref});
        } else if(!getUid(e)&&inPool(e,me.id)){
          pending.push({k,date,slot,pSize:poolSize(e)});
        }
      });
    });
    return(<>
      <h1 className="text-2xl font-semibold mb-1">My shifts</h1>
      <p className="text-sm text-slate-500 mb-4">{mine.length} awarded · {pending.length} in pool · {getPtsEarned(me.id).toFixed(1)} pts pending (credit when block locks)</p>
      {pending.length>0&&(
        <div className="mb-4">
          <div className="text-xs font-medium text-slate-500 mb-2 px-1">PENDING (in pool)</div>
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
                    <span className="font-medium" style={{color:m.slot?.color}}>{m.slot?.name}</span>
                    <span className="text-slate-500">· {others===0?"only you":`you + ${others} other${others===1?"":"s"}`}</span>
                  </div>
                </div>
                <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full font-medium">In pool</span>
              </button>
            );
          })}</div>
        </div>
      )}
      {mine.length>0&&pending.length>0&&<div className="text-xs font-medium text-slate-500 mb-2 px-1">AWARDED</div>}
      {!mine.length&&!pending.length?
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center"><div className="text-3xl mb-2">📅</div><p className="text-sm text-slate-500">No shifts yet. Join a pool on the Shifts page.</p></div>
        :mine.length>0?<div className="space-y-2">{mine.map((m,i)=>(
          <button key={i} onClick={()=>setEditingDay(m.k)} className="w-full bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3 active:bg-slate-50 text-left">
            <div className="w-12 h-12 rounded-lg bg-slate-50 flex flex-col items-center justify-center">
              <div className="text-[10px] font-bold text-slate-500">{DAYS_SHORT[m.date.getDay()]}</div>
              <div className="text-lg font-bold">{m.date.getDate()}</div>
            </div>
            <div className="flex-1">
              <div className="font-medium text-sm">{MONTHS_SHORT[m.date.getMonth()]} {m.date.getDate()}, {m.date.getFullYear()}</div>
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-medium" style={{color:m.slot?.color}}>{m.slot?.name}</span>
                {m.auto&&<span className="bg-blue-100 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 rounded">Auto +{(config.involuntaryBonus||0)+(m.nonPref?(config.nonPreferredBonus||0):0)}{m.nonPref&&(config.nonPreferredBonus||0)>0?" ★":""}</span>}
                {m.nonPref&&(config.nonPreferredBonus||0)>0&&<span className="text-[10px] text-slate-500">non-preferred</span>}
              </div>
            </div>
            <span className="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full font-medium">+{(m.pts+(m.auto?(config.involuntaryBonus||0):0)+(m.nonPref?(config.nonPreferredBonus||0):0)).toFixed(m.pts%1?2:0)}</span>
          </button>
        ))}</div>:null
      }
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

  // v2 SetupPage — modular card windows matching SchedulePage aesthetic.
  // Each settings group lives in its own bg-surface rounded-2xl shadow-card panel with
  // an icon tile + bold heading + brief description. Top Action card surfaces the signup/reconcile CTA.
  const SetupPage = () => {
    const holidayList = Object.entries(config.holidays);
    // Top action state — Create / Set dates / Open signup / Close & reconcile
    const canAct = !!currentBlock && !!currentBlock.start && !!currentBlock.end;
    const signupOpen = !!currentBlock?.signupOpen;
    const actionLabel = !currentBlock
      ? "Create a block first"
      : !currentBlock.start || !currentBlock.end
        ? "Set block start + end dates"
        : signupOpen
          ? `Close signup & reconcile ${currentBlock.name||"block"}`
          : `Open signup for ${currentBlock.name||"block"}`;
    const actionBtn = signupOpen
      ? "bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-600 hover:to-rose-700 text-white"
      : "bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white";
    const statusText = signupOpen ? "text-emerald-600" : "text-ink-500";
    const statusLabel = !currentBlock
      ? "No current block"
      : !currentBlock.start || !currentBlock.end
        ? "Dates missing"
        : signupOpen
          ? "Signup open"
          : "Signup closed";
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
            <div className={`text-[10px] font-bold uppercase tracking-[0.15em] ${statusText}`}>Current block</div>
            <div className="text-lg sm:text-xl font-bold mt-1 text-ink-900 truncate">
              {currentBlock?.name || "None selected"}
            </div>
            {currentBlock?.start&&currentBlock?.end&&(
              <div className="text-xs text-ink-500 mt-1 tabular-nums">
                {currentBlock.start} → {currentBlock.end}
              </div>
            )}
          </div>
          <div className={`text-sm font-bold px-3 py-1.5 rounded-full ${signupOpen?"bg-emerald-100 text-emerald-700":"bg-slate-100 text-ink-500"}`}>
            {statusLabel}
          </div>
        </div>
        <button onClick={()=>signupOpen?setReconcilePreview(computeReconcile()):updateCurrentBlock({signupOpen:true})}
          disabled={!canAct}
          className={`w-full py-3.5 text-sm font-bold rounded-xl shadow-card transition ${canAct?actionBtn:"bg-slate-200 text-ink-400 cursor-not-allowed"}`}>
          {actionLabel}
        </button>
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
            const nb = { id, name:`Block ${n}`, start:"", end:"", signupOpen:false };
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
                    <span className="text-ink-500">
                      Signup <span className={b.signupOpen?"text-emerald-600 font-bold":"text-ink-700 font-semibold"}>{b.signupOpen?"open":"closed"}</span>
                    </span>
                    {isCur&&<span className="text-ink-400 italic">Toggle with the action button above</span>}
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
      {me.role==="admin"&&<button onClick={()=>{setAddUserForm({name:"",username:"",email:"",role:"provider",seniorityId:""});setAddUserOpen(true);}} className="flex-shrink-0 bg-blue-600 text-white text-sm font-medium px-3 py-2 rounded-lg hover:bg-blue-700">+ Add user</button>}
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
  const groupMemberCount = (gid) => {
    try { const raw = localStorage.getItem("shyft_"+gKey(gid,"users")); if(!raw) return 0; return (JSON.parse(raw)||[]).length; } catch { return 0; }
  };
  const SuperDashboard = () => (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-purple-600 text-white flex items-center justify-center font-bold">S</div>
          <span className="font-semibold text-slate-900">Shyft</span>
          <span className="ml-2 text-[10px] sm:text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium whitespace-nowrap">Owner</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-sm text-slate-700">{me.name}</span>
          <button onClick={signOut} className="text-xs sm:text-sm px-3 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50">Sign out</button>
        </div>
      </nav>
      <main className="p-4 sm:p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Groups</h1>
        <p className="text-sm text-slate-500 mb-5">Every group has its own users, calendar, and settings. Share the codes with the group's members.</p>

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
            const mc = groupMemberCount(g.id);
            return(
              <div key={g.id} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="font-semibold text-base">{g.name}</div>
                    <div className="text-xs text-slate-500">{mc} member{mc===1?"":"s"} · created {new Date(g.createdAt).toLocaleDateString()}</div>
                  </div>
                  <button onClick={()=>deleteGroup(g.id)} className="text-red-600 hover:text-red-700 text-xs font-medium px-2 py-1">Delete</button>
                </div>
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
      {toast&&<Toast msg={toast}/>}
    </div>
  );

  /* ══ NAV & RENDER ══ */
  if(me.role==="super") return SuperDashboard();

  const navItems = me.role==="admin"
    ? [{id:"home",icon:"📊",label:"Home"},{id:"shifts",icon:"📅",label:"Calendar"},{id:"setup",icon:"⚙️",label:"Setup"},{id:"people",icon:"👥",label:"People"}]
    : [{id:"home",icon:"🏠",label:"Home"},{id:"schedule",icon:"📅",label:"Schedule"},{id:"myshifts",icon:"✅",label:"Mine"},{id:"standings",icon:"⭐",label:"Ranks"}];

  const renderPage = () => {
    if(page==="home") return me.role==="admin"?AdminHome():ProviderHome();
    // "shifts" is the admin-side calendar page; providers land here too if they came from a pre-merge link.
    if(page==="shifts") return me.role==="admin"?ShiftsPage():SchedulePage();
    if(page==="schedule") return SchedulePage();
    // Legacy availability route → redirect to the merged schedule page.
    if(page==="availability") return SchedulePage();
    if(page==="myshifts") return MyShiftsPage();
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
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-[260px] flex-shrink-0 bg-surface border-r border-slate-200 px-4 py-5 sticky top-0 h-screen">
        <div className="flex items-center gap-2.5 mb-6 px-2">
          <div className="w-10 h-10 rounded-xl bg-brand-700 text-white flex items-center justify-center font-bold text-lg shadow-card">S</div>
          <div>
            <div className="font-semibold text-ink-900 text-base leading-tight">Shyft</div>
            <div className="text-[10px] font-semibold text-brand-700 uppercase tracking-wider leading-tight mt-0.5">v2 · preview</div>
          </div>
        </div>
        {currentBlock&&(
          <div className="mb-5 p-3.5 rounded-xl bg-brand-50 border border-brand-100">
            <div className="text-[10px] font-semibold text-brand-700 uppercase tracking-wider">Current block</div>
            <div className="text-sm font-semibold text-ink-900 mt-1 truncate">{currentBlock.name||"Block"}</div>
            <div className="text-xs text-ink-500 mt-0.5">{blockRangeLabel}</div>
            <div className={`text-[10px] font-semibold mt-2 inline-flex items-center gap-1.5 ${currentBlock.signupOpen?"text-emerald-600":"text-ink-500"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${currentBlock.signupOpen?"bg-emerald-500":"bg-ink-400"}`}></span>
              Signup {currentBlock.signupOpen?"open":"closed"}
            </div>
          </div>
        )}
        <nav className="flex-1 space-y-0.5">{navItems.map(n=>(
          <button key={n.id} onClick={()=>setPage(n.id)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm w-full text-left transition ${page===n.id?"bg-brand-50 text-brand-700 font-semibold":"text-ink-700 hover:bg-slate-100"}`}>
            <span className="text-base leading-none">{n.icon}</span>
            <span>{n.label}</span>
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
            <div className="w-8 h-8 rounded-lg bg-brand-700 text-white flex items-center justify-center font-bold text-sm shadow-card flex-shrink-0">S</div>
            {currentBlock&&(
              <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap font-semibold ${currentBlock.signupOpen?"bg-emerald-50 text-emerald-700":"bg-slate-100 text-ink-500"}`}>
                {currentBlock.name||"Block"} · {currentBlock.signupOpen?"open":"closed"}
              </span>
            )}
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
            className={`flex-1 py-2.5 flex flex-col items-center gap-0.5 ${page===n.id?"text-brand-700":"text-ink-500"}`}>
            <span className="text-lg leading-none">{n.icon}</span>
            <span className="text-[10px] font-semibold">{n.label}</span>
          </button>
        ))}
      </nav>

      {DaySheet()}{Onboarding()}{AutoAssignModal()}{ReconcileModal()}{ConfirmResetModal()}{ConfirmBlockOverModal()}{BlockReportModal()}{AddUserModal()}{NewUserInfoModal()}
      {toast&&<Toast msg={toast}/>}
    </div>
  );
}

// v2 Stat: card with uppercase micro-label, prominent value, optional sub.
// The color prop sets value color (e.g. "text-brand-700"); default is inky.
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
