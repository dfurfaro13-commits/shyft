#!/usr/bin/env node
// simulate.js — Shyft May 2026 full simulation

const DAYS_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ── Core helpers (mirrored from ShiftApp.jsx) ──
const dk = (y, m, d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const parseDk = k => { const [y,m,d] = k.split("-").map(Number); return new Date(y,m-1,d); };
const isWeekend = k => { const d = parseDk(k).getDay(); return d===0||d===6; };
const getUid = e => (typeof e==="object"&&e!==null) ? e.uid : e;
const isAuto = e => typeof e==="object"&&e!==null&&!!e.auto;

// Seeded PRNG (mulberry32) — deterministic, reproducible
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
const rng = mkRng(42);
const randInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ── Config ──
// May 1, 2026 = Friday; Memorial Day = May 25 (last Monday of May)
const config = {
  blockStart: "2026-05-01",
  blockEnd:   "2026-05-31",
  shiftSlots: [
    { id: 1, name: "Primary", credit: 1.00 },
    { id: 2, name: "Backup",  credit: 0.75 },
  ],
  pointValues: { weekday: 0, fri: 1, sat: 2, sun: 1, holiday: 3 },
  holidays: { "2026-05-25": "Memorial Day" },
  seniorityLevels: [
    { id: 1, name: "Senior", minShifts: 2 },
    { id: 2, name: "Junior", minShifts: 3 },
  ],
  minAvailableDays: 10,
  minAvailableWeekendDays: 3,
  involuntaryBonus: 1,
  penaltyPerMissingDay: 1,
};

// ── Block days ──
function getBlockDays() {
  const out = [];
  const end = parseDk(config.blockEnd);
  for (let d = parseDk(config.blockStart); d <= end; d.setDate(d.getDate() + 1))
    out.push(dk(d.getFullYear(), d.getMonth(), d.getDate()));
  return out;
}
const blockDays = getBlockDays();
const blockWeekendDays = blockDays.filter(isWeekend);

function dayPts(k) {
  const date = parseDk(k);
  if (config.holidays[k]) return config.pointValues.holiday;
  const dow = date.getDay();
  if (dow === 5) return config.pointValues.fri;
  if (dow === 6) return config.pointValues.sat;
  if (dow === 0) return config.pointValues.sun;
  return config.pointValues.weekday;
}

// ── Users ──
const NAMES = [
  "Alex Chen",     "Jordan Rivera", "Morgan Patel",  "Casey Williams",
  "Taylor Brooks", "Drew Anderson", "Riley Johnson", "Avery Martinez",
  "Jamie Thompson","Quinn Garcia",  "Skyler Lee",    "Reese Nguyen",
  "Blake Harris",  "Sage Turner",   "Finley Clark",  "Rowan Lewis",
  "Parker Hall",   "Elliot Young",  "Sawyer King",   "Dylan Scott",
];
// Varied prior points to create interesting standings
const PRIOR_PTS = [5, 3, 8, 0, 12, 2, 7, 1, 4, 9, 6, 0, 11, 3, 5, 8, 2, 7, 4, 6];

// First 8 = Senior (min 2 shifts), next 12 = Junior (min 3 shifts)
const users = NAMES.map((name, i) => ({
  id: i + 1,
  name,
  username: name.split(" ")[0].toLowerCase() + (i + 1),
  role: "provider",
  seniorityId: i < 8 ? 1 : 2,
  points: PRIOR_PTS[i],
}));

// ── Simulation state ──
let shifts = {};
let unavailability = {};

// ── Point helpers (exact logic from ShiftApp.jsx) ──
const isUnavail = (uid, k) => (unavailability[uid] || []).includes(k);

function getAvailInfo(uid) {
  const blocked = (unavailability[uid] || []).filter(k => k >= config.blockStart && k <= config.blockEnd);
  const blockedWk = blocked.filter(isWeekend);
  const availD = blockDays.length - blocked.length;
  const availW = blockWeekendDays.length - blockedWk.length;
  const dayShort = Math.max(0, config.minAvailableDays - availD);
  const wkShort  = Math.max(0, config.minAvailableWeekendDays - availW);
  const totalShort = dayShort + wkShort;
  return { availD, availW, dayShort, wkShort, penalty: totalShort * config.penaltyPerMissingDay, meets: totalShort === 0 };
}

function getPtsEarned(uid) {
  let t = 0;
  Object.entries(shifts).forEach(([k, day]) => {
    Object.entries(day).forEach(([sid, entry]) => {
      if (getUid(entry) === uid) {
        const slot = config.shiftSlots.find(s => s.id === parseInt(sid));
        t += dayPts(k) * (slot?.credit || 1);
        if (isAuto(entry)) t += config.involuntaryBonus;
      }
    });
  });
  return t;
}

function getShiftCount(uid) {
  let n = 0;
  Object.values(shifts).forEach(d => Object.values(d).forEach(e => { if (getUid(e) === uid) n++; }));
  return n;
}

function getAutoCount(uid) {
  let n = 0;
  Object.values(shifts).forEach(d => Object.values(d).forEach(e => { if (getUid(e) === uid && isAuto(e)) n++; }));
  return n;
}

function totalPts(uid) {
  const u = users.find(x => x.id === uid);
  return (u?.points || 0) + getPtsEarned(uid) - getAvailInfo(uid).penalty;
}

// ══════════════════════════════════════════════════════════════
// OUTPUT HELPERS
// ══════════════════════════════════════════════════════════════
const W = 68;
const line  = "─".repeat(W);
const dline = "═".repeat(W);

// ══════════════════════════════════════════════════════════════
// ACCOUNTS
// ══════════════════════════════════════════════════════════════
console.log("\n" + dline);
console.log("  SHYFT — MAY 2026 SIMULATION");
console.log("  31 days · 2 slots/day · 62 total shifts · 20 providers");
console.log(dline);

console.log("\n📋  ACCOUNTS\n");
console.log("  " + line);
console.log(`  ${"#".padEnd(4)}${"Name".padEnd(20)}${"Username".padEnd(16)}${"Level".padEnd(10)}Prior pts`);
console.log("  " + line);
users.forEach((u, i) => {
  const lvl = config.seniorityLevels.find(l => l.id === u.seniorityId);
  console.log(`  ${String(i+1).padEnd(4)}${u.name.padEnd(20)}${ ("@"+u.username).padEnd(16)}${lvl.name.padEnd(10)}${u.points}`);
});

// ══════════════════════════════════════════════════════════════
// PHASE 1: AVAILABILITY
// ══════════════════════════════════════════════════════════════
console.log("\n\n🚫  PHASE 1 — AVAILABILITY\n");
console.log(`  Each provider marks days they can't work.`);
console.log(`  Minimum: ≥${config.minAvailableDays} available days, ≥${config.minAvailableWeekendDays} weekend days.`);
console.log(`  Penalty: −${config.penaltyPerMissingDay} pt per day short.\n`);
console.log("  " + line);
console.log(`  ${"Name".padEnd(20)}${"Blocked".padEnd(9)}${"Avail days".padEnd(12)}${"Wknds".padEnd(8)}Status`);
console.log("  " + line);

users.forEach(u => {
  const maxBlock   = blockDays.length - config.minAvailableDays;
  const maxWkBlock = blockWeekendDays.length - config.minAvailableWeekendDays;

  const wkToBlock = randInt(0, maxWkBlock);
  const wkBlocked = shuffle(blockWeekendDays).slice(0, wkToBlock);
  const weekdays  = blockDays.filter(d => !isWeekend(d));
  const wdToBlock = randInt(0, Math.min(maxBlock - wkToBlock, weekdays.length));
  const wdBlocked = shuffle(weekdays).slice(0, wdToBlock);
  unavailability[u.id] = [...wkBlocked, ...wdBlocked];

  const a = getAvailInfo(u.id);
  const statusStr = a.meets ? "✓ OK" : `⚠  penalty −${a.penalty} pt`;
  console.log(`  ${u.name.padEnd(20)}${String(unavailability[u.id].length).padEnd(9)}${String(a.availD).padEnd(12)}${String(a.availW).padEnd(8)}${statusStr}`);
});

// ══════════════════════════════════════════════════════════════
// PHASE 2: VOLUNTARY SIGNUP
// ══════════════════════════════════════════════════════════════
console.log("\n\n✍️   PHASE 2 — VOLUNTARY SIGNUP\n");
console.log("  Providers pick preferred shifts (weekends & holidays first).");
console.log("  If two providers want the same slot, higher total points wins.\n");

// Sorted preference: holiday > sat > fri/sun > weekday
const valueDays = blockDays.filter(k => dayPts(k) > 0);

const signupPlans = users.map(u => {
  const lvl = config.seniorityLevels.find(l => l.id === u.seniorityId);
  const wantShifts = randInt(lvl.minShifts, lvl.minShifts + 2);
  const preferred = [
    ...shuffle(valueDays.filter(k => dayPts(k) === 3)),
    ...shuffle(valueDays.filter(k => dayPts(k) === 2)),
    ...shuffle(valueDays.filter(k => dayPts(k) === 1)),
  ].filter(k => !isUnavail(u.id, k));
  return { u, preferred, wantShifts };
});

const signedCount = {};
users.forEach(u => { signedCount[u.id] = 0; });
const conflictLog = [];

// Round-robin signup — each person picks one shift per round
const maxRounds = Math.max(...signupPlans.map(s => s.wantShifts));
for (let round = 0; round < maxRounds; round++) {
  for (const { u, preferred, wantShifts } of shuffle(signupPlans)) {
    if (signedCount[u.id] >= wantShifts) continue;

    for (const dateKey of preferred) {
      if (Object.values(shifts[dateKey] || {}).some(e => getUid(e) === u.id)) continue;

      let tookSlot = false;
      for (const slot of config.shiftSlots) {
        const existing    = shifts[dateKey]?.[slot.id];
        const existingUid = existing ? getUid(existing) : null;

        if (!existing) {
          if (!shifts[dateKey]) shifts[dateKey] = {};
          shifts[dateKey][slot.id] = { uid: u.id, auto: false };
          signedCount[u.id]++;
          tookSlot = true;
          break;
        } else if (existingUid !== u.id) {
          const myPts    = totalPts(u.id);
          const theirPts = totalPts(existingUid);
          if (myPts > theirPts) {
            conflictLog.push({
              winner: u,
              loser: users.find(x => x.id === existingUid),
              dateKey, slot, winnerPts: myPts, loserPts: theirPts,
            });
            shifts[dateKey][slot.id] = { uid: u.id, auto: false };
            signedCount[existingUid] = Math.max(0, signedCount[existingUid] - 1);
            signedCount[u.id]++;
            tookSlot = true;
            break;
          }
        }
      }
      if (tookSlot) break;
    }
  }
}

const voluntaryFilled = Object.values(shifts).reduce((a, d) =>
  a + Object.values(d).filter(e => !isAuto(e)).length, 0);
const totalSlots = blockDays.length * config.shiftSlots.length;
console.log(`  ${voluntaryFilled} of ${totalSlots} slots claimed voluntarily\n`);

if (conflictLog.length > 0) {
  console.log(`  ⚔  ${conflictLog.length} contested slot(s) — resolved by points:\n`);
  const showConflicts = conflictLog.slice(0, 12);
  showConflicts.forEach(c => {
    const date = parseDk(c.dateKey);
    const pts  = dayPts(c.dateKey);
    const holTag = config.holidays[c.dateKey] ? ` (${config.holidays[c.dateKey]})` : "";
    console.log(
      `     May ${String(date.getDate()).padStart(2)} ${DAYS_SHORT[date.getDay()]}${holTag} +${pts}  ` +
      `${c.slot.name.padEnd(8)}  ${c.winner.name.padEnd(16)} (${c.winnerPts.toFixed(1)}) ` +
      `took from ${c.loser.name} (${c.loserPts.toFixed(1)})`
    );
  });
  if (conflictLog.length > 12) console.log(`     … and ${conflictLog.length - 12} more`);
}

// ══════════════════════════════════════════════════════════════
// PHASE 3: AUTO-ASSIGN
// ══════════════════════════════════════════════════════════════
console.log("\n\n⚙   PHASE 3 — AUTO-ASSIGN REMAINING OPEN SLOTS\n");

const assignedBefore = Object.values(shifts).reduce((a, d) => a + Object.keys(d).length, 0);
const openBefore = totalSlots - assignedBefore;
console.log(`  ${assignedBefore} filled, ${openBefore} open — auto-assigning now…\n`);

// Mirror computeAutoAssign() from ShiftApp.jsx exactly
const provs = users.filter(p => p.seniorityId);
const liveCount = {};
provs.forEach(p => { liveCount[p.id] = 0; });
Object.values(shifts).forEach(day => Object.values(day).forEach(e => {
  const uid = getUid(e);
  if (liveCount[uid] !== undefined) liveCount[uid]++;
}));

const autoAssigned = [];
const unfilled = [];

for (const dateKey of blockDays) {
  for (const slot of config.shiftSlots) {
    if (shifts[dateKey]?.[slot.id]) continue;

    const elig = provs.filter(p => {
      if (isUnavail(p.id, dateKey)) return false;
      return !Object.values(shifts[dateKey] || {}).some(e => getUid(e) === p.id);
    });

    if (!elig.length) { unfilled.push({ dateKey, slot }); continue; }

    elig.sort((a, b) => {
      const aMin = config.seniorityLevels.find(l => l.id === a.seniorityId)?.minShifts || 0;
      const bMin = config.seniorityLevels.find(l => l.id === b.seniorityId)?.minShifts || 0;
      const aB = Math.max(0, aMin - liveCount[a.id]);
      const bB = Math.max(0, bMin - liveCount[b.id]);
      if (aB !== bB) return bB - aB;
      if (liveCount[a.id] !== liveCount[b.id]) return liveCount[a.id] - liveCount[b.id];
      return totalPts(a.id) - totalPts(b.id);
    });

    const winner = elig[0];
    if (!shifts[dateKey]) shifts[dateKey] = {};
    shifts[dateKey][slot.id] = { uid: winner.id, auto: true };
    liveCount[winner.id]++;
    autoAssigned.push({ dateKey, slot, user: winner });
  }
}

console.log(`  ✅ ${autoAssigned.length} shifts auto-assigned (+${config.involuntaryBonus} bonus pt each)`);
if (unfilled.length > 0) {
  console.log(`\n  ⚠  ${unfilled.length} slot(s) unfillable — everyone is unavailable:`);
  unfilled.forEach(f => {
    const date = parseDk(f.dateKey);
    console.log(`     May ${date.getDate()} ${DAYS_SHORT[date.getDay()]} — ${f.slot.name}`);
  });
}

// ══════════════════════════════════════════════════════════════
// FINAL SCHEDULE
// ══════════════════════════════════════════════════════════════
console.log("\n\n📆  FINAL SCHEDULE — MAY 2026\n");
console.log("  ● = weekend/holiday    ⚙ = auto-assigned\n");
console.log("  " + line);

blockDays.forEach(k => {
  const date   = parseDk(k);
  const pts    = dayPts(k);
  const hol    = config.holidays[k];
  const dayS   = shifts[k] || {};
  const dow    = DAYS_SHORT[date.getDay()];
  const wkMark = (isWeekend(k) || hol) ? "●" : " ";

  const slotStr = config.shiftSlots.map(s => {
    const entry = dayS[s.id];
    const uid   = entry ? getUid(entry) : null;
    const u     = uid ? users.find(x => x.id === uid) : null;
    const auto  = entry ? isAuto(entry) : false;
    const name  = u ? u.name.split(" ")[0] + (auto ? "⚙" : "") : "OPEN";
    return `${s.name}: ${name.padEnd(11)}`;
  }).join(" │ ");

  const ptTag  = pts > 0 ? `[+${pts}]` : "    ";
  const holTag = hol ? ` ← 🏖 ${hol}` : "";
  console.log(`  ${wkMark} May ${String(date.getDate()).padStart(2)} ${dow} ${ptTag}  ${slotStr}${holTag}`);
});

// ══════════════════════════════════════════════════════════════
// FINAL STANDINGS
// ══════════════════════════════════════════════════════════════
console.log("\n\n🏆  FINAL STANDINGS\n");
console.log("  Prior = carry-over pts from previous blocks");
console.log("  Earned = pts from this block's shifts");
console.log("  Penalty = availability shortfall deduction");
console.log("  Total = Prior + Earned − Penalty  (determines priority next block)\n");
console.log("  " + line);
console.log(`  ${"#".padEnd(4)}${"Name".padEnd(20)}${"Level".padEnd(9)}${"Shifts".padEnd(8)}${"Prior".padEnd(7)}${"Earned".padEnd(9)}${"Penalty".padEnd(10)}Total`);
console.log("  " + line);

const standings = users.map(u => {
  const earned = getPtsEarned(u.id);
  const avail  = getAvailInfo(u.id);
  const total  = totalPts(u.id);
  const count  = getShiftCount(u.id);
  const autoC  = getAutoCount(u.id);
  const lvl    = config.seniorityLevels.find(l => l.id === u.seniorityId);
  return { ...u, earned, avail, total, count, autoC, lvl };
}).sort((a, b) => b.total - a.total);

standings.forEach((u, i) => {
  const autoStr  = u.autoC > 0 ? `(${u.autoC}⚙)` : "";
  const countStr = `${u.count}${autoStr}`;
  const penStr   = u.avail.penalty > 0 ? `−${u.avail.penalty}` : "0";
  const warn     = !u.avail.meets ? " ⚠" : "";
  console.log(
    `  ${String(i+1).padEnd(4)}${u.name.padEnd(20)}${(u.lvl?.name||"—").padEnd(9)}` +
    `${countStr.padEnd(8)}${String(u.points).padEnd(7)}` +
    `${u.earned.toFixed(1).padEnd(9)}${(penStr+warn).padEnd(10)}${u.total.toFixed(1)}`
  );
});

// ══════════════════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════════════════
const finalAssigned = Object.values(shifts).reduce((a, d) => a + Object.keys(d).length, 0);
const finalVoluntary = Object.values(shifts).reduce((a, d) =>
  a + Object.values(d).filter(e => !isAuto(e)).length, 0);
const finalAuto = finalAssigned - finalVoluntary;
const belowMin  = standings.filter(u => !u.avail.meets).length;
const belowShiftMin = standings.filter(u => {
  const lvl = config.seniorityLevels.find(l => l.id === u.seniorityId);
  return u.count < (lvl?.minShifts || 0);
}).length;

console.log("\n\n📊  SUMMARY\n");
console.log(`  Block:               May 1–31, 2026 (${blockDays.length} days)`);
console.log(`  Total slots:         ${totalSlots}  (${blockDays.length} days × ${config.shiftSlots.length} slots)`);
console.log(`  Voluntarily filled:  ${finalVoluntary}`);
console.log(`  Auto-assigned:       ${finalAuto}  (+${config.involuntaryBonus} bonus pt each)`);
console.log(`  Unfilled:            ${unfilled.length}`);
console.log(`  Conflicts resolved:  ${conflictLog.length}`);
console.log(`  Below avail min:     ${belowMin} provider(s) — penalty applied`);
console.log(`  Below shift min:     ${belowShiftMin} provider(s)`);
console.log(`  Avg shifts/provider: ${(finalAssigned / users.length).toFixed(1)}`);
console.log();
