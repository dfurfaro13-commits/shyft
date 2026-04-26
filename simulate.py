#!/usr/bin/env python3
# simulate.py — Shyft May 2026 simulation (logic mirrored from ShiftApp.jsx)

import random
from datetime import date, timedelta
from copy import deepcopy

# ── Seeded RNG (deterministic, reproducible) ──
rng = random.Random(42)

def rand_int(lo, hi):   return rng.randint(lo, hi)
def shuffle(lst):       a = list(lst); rng.shuffle(a); return a

# ── Date helpers ──
def dk(y, m, d):        return f"{y}-{m:02d}-{d:02d}"
def parse_dk(k):        y,m,d = map(int,k.split("-")); return date(y,m,d)
def is_weekend(k):      return parse_dk(k).weekday() in (5, 6)  # Sat=5, Sun=6
def get_uid(e):         return e["uid"] if isinstance(e, dict) else e
def is_auto(e):         return isinstance(e, dict) and e.get("auto", False)

# ── Config ──
# May 1, 2026 = Friday; Memorial Day = May 25 (last Monday of May 2026)
config = {
    "blockStart": "2026-05-01",
    "blockEnd":   "2026-05-31",
    "shiftSlots": [
        {"id": 1, "name": "Primary", "credit": 1.00},
        {"id": 2, "name": "Backup",  "credit": 0.75},
    ],
    "pointValues": {"weekday": 0, "fri": 1, "sat": 2, "sun": 1, "holiday": 3},
    "holidays":    {"2026-05-25": "Memorial Day"},
    "seniorityLevels": [
        {"id": 1, "name": "Senior", "minShifts": 2},
        {"id": 2, "name": "Junior", "minShifts": 3},
    ],
    "minAvailableDays":    10,
    "minAvailableWeekendDays": 3,
    "involuntaryBonus":    1,
    "penaltyPerMissingDay": 1,
}

# ── Block days ──
def get_block_days():
    out, d = [], parse_dk(config["blockStart"])
    end = parse_dk(config["blockEnd"])
    while d <= end:
        out.append(dk(d.year, d.month, d.day))
        d += timedelta(days=1)
    return out

block_days = get_block_days()
block_weekend_days = [k for k in block_days if is_weekend(k)]
DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]  # Python weekday() 0=Mon

def day_pts(k):
    d = parse_dk(k)
    if k in config["holidays"]: return config["pointValues"]["holiday"]
    wd = d.weekday()  # 0=Mon … 6=Sun
    if wd == 4: return config["pointValues"]["fri"]
    if wd == 5: return config["pointValues"]["sat"]
    if wd == 6: return config["pointValues"]["sun"]
    return config["pointValues"]["weekday"]

# ── Users ──
NAMES = [
    "Alex Chen",      "Jordan Rivera",  "Morgan Patel",   "Casey Williams",
    "Taylor Brooks",  "Drew Anderson",  "Riley Johnson",  "Avery Martinez",
    "Jamie Thompson", "Quinn Garcia",   "Skyler Lee",     "Reese Nguyen",
    "Blake Harris",   "Sage Turner",    "Finley Clark",   "Rowan Lewis",
    "Parker Hall",    "Elliot Young",   "Sawyer King",    "Dylan Scott",
]
PRIOR_PTS = [5, 3, 8, 0, 12, 2, 7, 1, 4, 9, 6, 0, 11, 3, 5, 8, 2, 7, 4, 6]

# First 8 = Senior (min 2 shifts), next 12 = Junior (min 3 shifts)
users = [
    {
        "id": i + 1,
        "name": name,
        "username": name.split()[0].lower() + str(i + 1),
        "role": "provider",
        "seniorityId": 1 if i < 8 else 2,
        "points": PRIOR_PTS[i],
    }
    for i, name in enumerate(NAMES)
]

def seniority(u):
    return next(l for l in config["seniorityLevels"] if l["id"] == u["seniorityId"])

# ── Simulation state ──
shifts        = {}   # { dateKey: { slotId: {"uid": ..., "auto": bool} } }
unavailability= {}   # { uid: [dateKey, ...] }

# ── Point helpers (exact logic from ShiftApp.jsx) ──
def is_unavail(uid, k):
    return k in unavailability.get(uid, [])

def get_avail_info(uid):
    blocked    = [k for k in unavailability.get(uid, [])
                  if config["blockStart"] <= k <= config["blockEnd"]]
    blocked_wk = [k for k in blocked if is_weekend(k)]
    avail_d    = len(block_days) - len(blocked)
    avail_w    = len(block_weekend_days) - len(blocked_wk)
    day_short  = max(0, config["minAvailableDays"] - avail_d)
    wk_short   = max(0, config["minAvailableWeekendDays"] - avail_w)
    total_short= day_short + wk_short
    penalty    = total_short * config["penaltyPerMissingDay"]
    return dict(avail_d=avail_d, avail_w=avail_w, day_short=day_short,
                wk_short=wk_short, penalty=penalty, meets=(total_short == 0))

def get_pts_earned(uid):
    t = 0
    for k, day in shifts.items():
        for sid, entry in day.items():
            if get_uid(entry) == uid:
                slot = next((s for s in config["shiftSlots"] if s["id"] == int(sid)), None)
                t += day_pts(k) * (slot["credit"] if slot else 1)
                if is_auto(entry):
                    t += config["involuntaryBonus"]
    return t

def get_shift_count(uid):
    return sum(1 for day in shifts.values() for e in day.values() if get_uid(e) == uid)

def get_auto_count(uid):
    return sum(1 for day in shifts.values() for e in day.values()
               if get_uid(e) == uid and is_auto(e))

def total_pts(uid):
    u = next(x for x in users if x["id"] == uid)
    return u["points"] + get_pts_earned(uid) - get_avail_info(uid)["penalty"]

# ══════════════════════════════════════════════════════════════
# OUTPUT
# ══════════════════════════════════════════════════════════════
W = 68
line  = "─" * W
dline = "═" * W

# ══ ACCOUNTS ══
print(f"\n{dline}")
print("  SHYFT — MAY 2026 SIMULATION")
print("  31 days · 2 slots/day · 62 total shifts · 20 providers")
print(dline)

print("\n📋  ACCOUNTS\n")
print("  " + line)
print(f"  {'#':<4}{'Name':<20}{'Username':<16}{'Level':<10}Prior pts")
print("  " + line)
for i, u in enumerate(users):
    lvl = seniority(u)
    print(f"  {str(i+1):<4}{u['name']:<20}{'@'+u['username']:<16}{lvl['name']:<10}{u['points']}")

# ══ PHASE 1: AVAILABILITY ══
print("\n\n🚫  PHASE 1 — AVAILABILITY\n")
print(f"  Each provider marks days they can't work.")
print(f"  Minimum: ≥{config['minAvailableDays']} available days, "
      f"≥{config['minAvailableWeekendDays']} weekend days.")
print(f"  Penalty: −{config['penaltyPerMissingDay']} pt per day short.\n")
print("  " + line)
print(f"  {'Name':<20}{'Blocked':<9}{'Avail days':<12}{'Wknds':<8}Status")
print("  " + line)

for u in users:
    max_block    = len(block_days) - config["minAvailableDays"]
    max_wk_block = len(block_weekend_days) - config["minAvailableWeekendDays"]

    wk_to_block = rand_int(0, max_wk_block)
    wk_blocked  = shuffle(block_weekend_days)[:wk_to_block]
    weekdays    = [d for d in block_days if not is_weekend(d)]
    wd_to_block = rand_int(0, min(max_block - wk_to_block, len(weekdays)))
    wd_blocked  = shuffle(weekdays)[:wd_to_block]
    unavailability[u["id"]] = wk_blocked + wd_blocked

    a = get_avail_info(u["id"])
    status = "✓ OK" if a["meets"] else f"⚠  penalty −{a['penalty']} pt"
    print(f"  {u['name']:<20}{len(unavailability[u['id']]):<9}"
          f"{a['avail_d']:<12}{a['avail_w']:<8}{status}")

# ══ PHASE 2: VOLUNTARY SIGNUP ══
print("\n\n✍️   PHASE 2 — VOLUNTARY SIGNUP\n")
print("  Providers pick preferred shifts (weekends & holidays first, weekdays as fill-up).")
print("  Winning a conflict costs −1 pt immediately — curbs high-point dominance.\n")

CONFLICT_PENALTY = config.get("conflictPenalty", 1)

# Preference order: holiday > sat > fri/sun > weekday (everyone needs SOME weekdays too)
def make_preferred(uid):
    available = [k for k in block_days if not is_unavail(uid, k)]
    return (
        shuffle([k for k in available if day_pts(k) == 3]) +
        shuffle([k for k in available if day_pts(k) == 2]) +
        shuffle([k for k in available if day_pts(k) == 1]) +
        shuffle([k for k in available if day_pts(k) == 0])   # weekdays as last resort
    )

signup_plans = []
for u in users:
    lvl         = seniority(u)
    # Providers aim to fully cover their minimum; some pick 1-2 extra
    want_shifts = rand_int(lvl["minShifts"], lvl["minShifts"] + 2)
    signup_plans.append({"u": u, "preferred": make_preferred(u["id"]), "want": want_shifts})

signed_count = {u["id"]: 0 for u in users}
conflict_log = []

max_rounds = max(p["want"] for p in signup_plans)
for _ in range(max_rounds):
    for plan in shuffle(signup_plans):
        u = plan["u"]
        if signed_count[u["id"]] >= plan["want"]:
            continue

        for date_key in plan["preferred"]:
            if any(get_uid(e) == u["id"] for e in (shifts.get(date_key) or {}).values()):
                continue

            took = False
            for slot in config["shiftSlots"]:
                sid      = str(slot["id"])
                existing = (shifts.get(date_key) or {}).get(sid)
                ex_uid   = get_uid(existing) if existing else None

                if existing is None:
                    shifts.setdefault(date_key, {})[sid] = {"uid": u["id"], "auto": False}
                    signed_count[u["id"]] += 1
                    took = True
                    break
                elif ex_uid != u["id"]:
                    my_pts    = total_pts(u["id"])
                    their_pts = total_pts(ex_uid)
                    if my_pts > their_pts:
                        loser = next(x for x in users if x["id"] == ex_uid)
                        conflict_log.append({
                            "winner": u, "loser": loser,
                            "date_key": date_key, "slot": slot,
                            "winner_pts": my_pts, "loser_pts": their_pts,
                        })
                        shifts[date_key][sid] = {"uid": u["id"], "auto": False}
                        # Apply conflict penalty to winner immediately
                        u["points"] = max(0, u["points"] - CONFLICT_PENALTY)
                        signed_count[ex_uid] = max(0, signed_count[ex_uid] - 1)
                        signed_count[u["id"]] += 1
                        took = True
                        break
            if took:
                break

voluntary_filled = sum(
    1 for day in shifts.values() for e in day.values() if not is_auto(e)
)
total_slots = len(block_days) * len(config["shiftSlots"])
print(f"  {voluntary_filled} of {total_slots} slots claimed voluntarily\n")

if conflict_log:
    print(f"  ⚔  {len(conflict_log)} contested slot(s) — resolved by points:\n")
    for c in conflict_log[:12]:
        d    = parse_dk(c["date_key"])
        pts  = day_pts(c["date_key"])
        hol  = config["holidays"].get(c["date_key"], "")
        htag = f" ({hol})" if hol else ""
        dow  = DAYS_SHORT[d.weekday()]
        print(f"     May {d.day:>2} {dow}{htag} +{pts}  "
              f"{c['slot']['name']:<8}  {c['winner']['name']:<16} "
              f"({c['winner_pts']:.1f}) took from "
              f"{c['loser']['name']} ({c['loser_pts']:.1f})")
    if len(conflict_log) > 12:
        print(f"     … and {len(conflict_log) - 12} more")

# ══ PHASE 3: AUTO-ASSIGN ══
print("\n\n⚙   PHASE 3 — AUTO-ASSIGN REMAINING OPEN SLOTS\n")

assigned_before = sum(len(day) for day in shifts.values())
open_before = total_slots - assigned_before
print(f"  {assigned_before} filled, {open_before} open — auto-assigning now…\n")

provs      = [u for u in users if u.get("seniorityId")]
live_count = {u["id"]: 0 for u in provs}
for day in shifts.values():
    for e in day.values():
        uid = get_uid(e)
        if uid in live_count:
            live_count[uid] += 1

auto_assigned = []
unfilled      = []

for date_key in block_days:
    for slot in config["shiftSlots"]:
        sid = str(slot["id"])
        if (shifts.get(date_key) or {}).get(sid):
            continue

        elig = [
            p for p in provs
            if not is_unavail(p["id"], date_key)
            and not any(get_uid(e) == p["id"]
                        for e in (shifts.get(date_key) or {}).values())
        ]

        if not elig:
            unfilled.append({"date_key": date_key, "slot": slot})
            continue

        def sort_key(p):
            min_s = seniority(p)["minShifts"]
            behind = max(0, min_s - live_count[p["id"]])
            return (-behind, live_count[p["id"]], total_pts(p["id"]))

        elig.sort(key=sort_key)
        winner = elig[0]
        shifts.setdefault(date_key, {})[sid] = {"uid": winner["id"], "auto": True}
        live_count[winner["id"]] += 1
        auto_assigned.append({"date_key": date_key, "slot": slot, "user": winner})

print(f"  ✅ {len(auto_assigned)} shifts auto-assigned "
      f"(+{config['involuntaryBonus']} bonus pt each)")
if unfilled:
    print(f"\n  ⚠  {len(unfilled)} slot(s) unfillable — everyone is unavailable:")
    for f in unfilled:
        d   = parse_dk(f["date_key"])
        dow = DAYS_SHORT[d.weekday()]
        print(f"     May {d.day} {dow} — {f['slot']['name']}")

# ══ FINAL SCHEDULE ══
print("\n\n📆  FINAL SCHEDULE — MAY 2026\n")
print("  ● = weekend/holiday    ⚙ = auto-assigned\n")
print("  " + line)

for k in block_days:
    d     = parse_dk(k)
    pts   = day_pts(k)
    hol   = config["holidays"].get(k, "")
    day_s = shifts.get(k, {})
    dow   = DAYS_SHORT[d.weekday()]
    mark  = "●" if (is_weekend(k) or hol) else " "

    slot_parts = []
    for s in config["shiftSlots"]:
        entry = day_s.get(str(s["id"]))
        uid   = get_uid(entry) if entry else None
        u     = next((x for x in users if x["id"] == uid), None) if uid else None
        auto  = is_auto(entry) if entry else False
        name  = (u["name"].split()[0] + ("⚙" if auto else "")) if u else "OPEN"
        slot_parts.append(f"{s['name']}: {name:<11}")

    slot_str = " │ ".join(slot_parts)
    pt_tag   = f"[+{pts}]" if pts > 0 else "    "
    hol_tag  = f" ← 🏖 {hol}" if hol else ""
    print(f"  {mark} May {d.day:>2} {dow} {pt_tag}  {slot_str}{hol_tag}")

# ══ FINAL STANDINGS ══
print("\n\n🏆  FINAL STANDINGS\n")
print("  Prior = carry-over pts from previous blocks")
print("  Earned = pts from this block's shifts (auto-assigns include bonus)")
print("  Penalty = availability shortfall deduction")
print("  Total determines priority for next block's signup\n")
print("  " + line)
print(f"  {'#':<4}{'Name':<20}{'Level':<9}{'Shifts':<8}{'Prior':<7}{'Earned':<9}{'Penalty':<10}Total")
print("  " + line)

standings = []
for u in users:
    earned = get_pts_earned(u["id"])
    avail  = get_avail_info(u["id"])
    ttl    = total_pts(u["id"])
    count  = get_shift_count(u["id"])
    auto_c = get_auto_count(u["id"])
    lvl    = seniority(u)
    standings.append({**u, "earned": earned, "avail": avail,
                      "total": ttl, "count": count, "auto_c": auto_c, "lvl": lvl})

standings.sort(key=lambda x: -x["total"])

for i, u in enumerate(standings):
    auto_str  = f"({u['auto_c']}⚙)" if u["auto_c"] > 0 else ""
    count_str = f"{u['count']}{auto_str}"
    pen_str   = f"−{u['avail']['penalty']}" if u["avail"]["penalty"] > 0 else "0"
    warn      = " ⚠" if not u["avail"]["meets"] else ""
    print(f"  {str(i+1):<4}{u['name']:<20}{u['lvl']['name']:<9}"
          f"{count_str:<8}{str(u['points']):<7}"
          f"{u['earned']:<9.1f}{(pen_str+warn):<10}{u['total']:.1f}")

# ══ SUMMARY ══
final_assigned  = sum(len(day) for day in shifts.values())
final_voluntary = sum(1 for day in shifts.values() for e in day.values() if not is_auto(e))
final_auto      = final_assigned - final_voluntary
below_avail     = sum(1 for u in standings if not u["avail"]["meets"])
below_shift_min = sum(
    1 for u in standings
    if u["count"] < seniority(u)["minShifts"]
)

print("\n\n📊  SUMMARY\n")
print(f"  Block:                May 1–31, 2026 ({len(block_days)} days)")
print(f"  Total slots:          {total_slots}  ({len(block_days)} days × {len(config['shiftSlots'])} slots)")
print(f"  Voluntarily filled:   {final_voluntary}")
print(f"  Auto-assigned:        {final_auto}  (+{config['involuntaryBonus']} bonus pt each)")
print(f"  Unfilled:             {len(unfilled)}")
print(f"  Conflicts resolved:   {len(conflict_log)}")
print(f"  Below avail min:      {below_avail} provider(s) — penalty applied")
print(f"  Below shift min:      {below_shift_min} provider(s)")
print(f"  Avg shifts/provider:  {final_assigned / len(users):.1f}")
print()
