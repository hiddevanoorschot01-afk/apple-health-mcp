#!/usr/bin/env python3
"""Build the data files for the Hybrid Training dashboard.

Reads Apple Health data from this repo's deployed server (the `health_sql` tool on
/api/mcp), works out recovery, training load, heart-rate zones and weekly totals,
and writes four JSON files ({rows, meta}) to the output directory:

  dagen.json        one row per day: HRV, resting HR, sleep, VO2max, load, ACWR, readiness
  trainingen.json   one row per workout, duplicates from gym/tracking apps merged
  weken.json        one row per ISO week: running km, long run, strength sessions, minutes per sport
  vandaag.json      one row: today's readiness and the suggested session

With --push-summary it also stores today's summary on the server, as one sample of the
metric `dashboard_samenvatting` (POST /api/ingest), so the iPhone widget can read it.

Usage:
  python3 dashboard/build_data.py --out <dir> [--url https://<app>.vercel.app] [--days 120] [--push-summary]

Auth: sends `Authorization: Bearer $MCP_SECRET` when that variable is set. In a
Claude cloud session the network proxy injects the header instead, so no secret
is needed there. No health data is written into this repository.
"""

import argparse
import json
import math
import os
import statistics
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Amsterdam")
DEFAULT_URL = "https://apple-health-mcp-weld-iota.vercel.app"

# ---------------------------------------------------------------- fetching


def health_sql(base_url: str, query: str):
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "health_sql", "arguments": {"query": query}},
    }).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    secret = os.environ.get("MCP_SECRET")
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    req = urllib.request.Request(base_url.rstrip("/") + "/api/mcp", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=180) as resp:
        text = resp.read().decode()
    payload = None
    for line in text.splitlines():
        if line.startswith("data: "):
            payload = json.loads(line[6:])
    if payload is None:
        payload = json.loads(text)
    result = payload.get("result") or {}
    content = result.get("content") or [{}]
    out = content[0].get("text", "")
    if result.get("isError"):
        raise RuntimeError(f"health_sql failed: {out[:500]}")
    return json.loads(out)


def push_summary(base_url: str, summary: dict):
    """Store the summary as one metric sample; extra fields land in metric_samples.extra."""
    now = datetime.now(TZ)
    point = {"date": now.strftime("%Y-%m-%d %H:%M:%S %z"), "qty": summary.get("herstel"), "source": "dashboard"}
    point.update({k: v for k, v in summary.items() if k != "herstel"})
    body = json.dumps({"data": {"metrics": [{"name": "dashboard_samenvatting", "units": "score", "data": [point]}]}}).encode()
    headers = {"Content-Type": "application/json"}
    secret = os.environ.get("MCP_SECRET")
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    req = urllib.request.Request(base_url.rstrip("/") + "/api/ingest", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def parse_ts(s: str) -> datetime:
    """Postgres '2026-11-14 10:31:22+00' or HAE '2026-11-14 11:31:00 +0100' -> aware datetime."""
    s = s.strip().replace("T", " ")
    if s.endswith("+00"):
        s = s + ":00"
    for fmt in ("%Y-%m-%d %H:%M:%S%z", "%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S %z"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    return datetime.fromisoformat(s)


def local(dt: datetime) -> datetime:
    return dt.astimezone(TZ)


def r(v, nd=1):
    return None if v is None else round(v, nd)


# ---------------------------------------------------------------- workouts

SPORT = [
    ("Hardlopen", ("rennen", "hardlopen", "running")),
    ("Kracht", ("kracht", "strength", "core")),
    ("Fietsen", ("fietsen", "cycling")),
]


def sport_of(name: str) -> str:
    n = (name or "").lower()
    for sport, keys in SPORT:
        if any(k in n for k in keys):
            return sport
    return "Overig"


def source_priority(src: str) -> int:
    s = (src or "").lower()
    if "apple watch" in s:
        return 3
    if "motra" in s:
        return 2
    return 1


def overlap_s(a, b) -> float:
    return max(0.0, (min(a["end"], b["end"]) - max(a["start"], b["start"])).total_seconds())


def dedupe(workouts):
    """Merge the same session logged by several apps.

    - SportCity logs the whole gym visit. When a strength app (Motra) logged most of
      the strength time inside that visit, keep the app's session; otherwise keep the
      visit as the strength session, minus any run/ride logged inside it.
    - Two sessions that overlap for 80%+ of the shorter one (e.g. Strava copying
      Motra) are one session: keep the Apple Watch one, then Motra, then the rest,
      preferring a named sport over "Overig".
    """
    visits = [w for w in workouts if "sportcity" in (w["source"] or "").lower()]
    others = [w for w in workouts if w not in visits]

    kept = []
    for w in sorted(others, key=lambda w: (-source_priority(w["source"]), w["sport"] == "Overig", w["start"])):
        dup = False
        for k in kept:
            shorter = min((w["end"] - w["start"]).total_seconds(), (k["end"] - k["start"]).total_seconds()) or 1
            if overlap_s(w, k) / shorter >= 0.8:
                dup = True
                break
        if not dup:
            kept.append(w)

    for v in visits:
        inside = [k for k in kept if overlap_s(v, k) > 0]
        non_strength = sum(overlap_s(v, k) for k in inside if k["sport"] != "Kracht")
        strength_app = sum(overlap_s(v, k) for k in inside if k["sport"] == "Kracht")
        own = (v["end"] - v["start"]).total_seconds() - non_strength
        if strength_app >= 0.5 * own:
            continue  # the strength app already has this session
        kept = [k for k in kept if not (k["sport"] == "Kracht" and overlap_s(v, k) > 0)]
        v = dict(v)
        v["duration_s"] = own
        v["exclude"] = [(k["start"], k["end"]) for k in inside if k["sport"] != "Kracht"]
        kept.append(v)
    return sorted(kept, key=lambda w: w["start"])


def zones_and_trimp(hr_points, hr_rest, hr_max, exclude=()):
    """Per-minute HR samples -> minutes in 5 HR-reserve zones and Banister TRIMP."""
    z = [0.0] * 5
    trimp = 0.0
    reserve = max(hr_max - hr_rest, 1)
    for p in hr_points:
        hr = num(p.get("Avg"))
        ts = p.get("date")
        if hr is None or not ts:
            continue
        t = parse_ts(ts)
        if any(a <= t < b for a, b in exclude):
            continue
        frac = min(max((hr - hr_rest) / reserve, 0.0), 1.0)
        idx = 0 if frac < 0.6 else 1 if frac < 0.7 else 2 if frac < 0.8 else 3 if frac < 0.9 else 4
        z[idx] += 1
        trimp += frac * 0.64 * math.exp(1.92 * frac)
    return z, trimp


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--url", default=os.environ.get("HEALTH_URL", DEFAULT_URL))
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--today", help="YYYY-MM-DD, defaults to today in Europe/Amsterdam")
    ap.add_argument("--push-summary", action="store_true", help="store today's summary on the server for the widget")
    args = ap.parse_args()

    today = date.fromisoformat(args.today) if args.today else datetime.now(TZ).date()
    since = (today - timedelta(days=args.days)).isoformat()

    metrics = health_sql(args.url, f"""
        select metric_name, date, qty, avg, extra from metric_samples
        where date >= '{since}' and metric_name in (
          'heart_rate_variability','resting_heart_rate','sleep_analysis','vo2_max',
          'active_energy','step_count','respiratory_rate','apple_sleeping_wrist_temperature')
        order by date""")
    raw_workouts = health_sql(args.url, f"""
        select id, name, start, "end", duration_s, distance, distance_units, avg_hr, max_hr,
               active_energy, active_energy_units,
               raw->'source'->>'name' as source,
               raw->'heartRateData' as hr,
               raw->'elevationUp'->>'qty' as elev,
               raw->'effortScore'->>'qty' as effort
        from workouts where start >= '{since}' order by start""")

    # ---- daily metrics (local day)
    by_day = defaultdict(lambda: defaultdict(list))
    for m in metrics:
        name = m["metric_name"]
        t = local(parse_ts(m["date"]))
        q = num(m["qty"]) if m["qty"] is not None else num(m["avg"])
        if name == "sleep_analysis":
            ex = m.get("extra") or {}
            end = ex.get("sleepEnd") or ex.get("inBedEnd")
            d = local(parse_ts(end)).date() if end else t.date()
            by_day[d]["sleep"].append(ex)
        elif name == "heart_rate_variability":
            # Night/morning readings (22:00-10:00) belong to the morning they lead into.
            if t.hour >= 22:
                by_day[t.date() + timedelta(days=1)]["hrv_night"].append(q)
            elif t.hour < 10:
                by_day[t.date()]["hrv_night"].append(q)
            by_day[t.date()]["hrv_all"].append(q)
        elif q is not None:
            by_day[t.date()][name].append(q)

    hr_rest_all = [v for d in by_day.values() for v in d.get("resting_heart_rate", []) if v]
    hr_rest = statistics.median(hr_rest_all) if hr_rest_all else 55.0
    hr_max = max([num(w["max_hr"]) or 0 for w in raw_workouts] + [185.0])

    # ---- workouts
    ws = []
    for w in raw_workouts:
        if not w["start"] or not w["end"]:
            continue
        hr = w["hr"]
        if isinstance(hr, str):
            hr = json.loads(hr)
        ws.append({
            "id": w["id"], "name": w["name"], "sport": sport_of(w["name"]), "source": w["source"],
            "start": parse_ts(w["start"]), "end": parse_ts(w["end"]),
            "duration_s": num(w["duration_s"]) or 0, "distance": num(w["distance"]),
            "distance_units": w["distance_units"], "avg_hr": num(w["avg_hr"]), "max_hr": num(w["max_hr"]),
            "elev": num(w["elev"]), "effort": num(w["effort"]), "hr": hr or [], "exclude": [],
        })
    ws = dedupe(ws)

    workout_rows = []
    load_by_day = defaultdict(float)
    for w in ws:
        z, trimp = zones_and_trimp(w["hr"], hr_rest, hr_max, w["exclude"])
        minutes = w["duration_s"] / 60
        if not w["hr"] and w["avg_hr"]:  # no per-minute data: estimate from the average
            frac = min(max((w["avg_hr"] - hr_rest) / (hr_max - hr_rest), 0), 1)
            trimp = minutes * frac * 0.64 * math.exp(1.92 * frac)
        km = w["distance"]
        if km is not None and (w["distance_units"] or "km") == "m":
            km = km / 1000
        pace = (minutes / km) if (w["sport"] == "Hardlopen" and km and km > 0.5) else None
        avg_hr = w["avg_hr"]
        m_per_beat = (km * 1000 / (avg_hr * minutes)) if (pace and avg_hr) else None
        st = local(w["start"])
        load_by_day[st.date()] += trimp
        workout_rows.append({
            "id": w["id"], "datum": st.date().isoformat(), "start": st.strftime("%Y-%m-%d %H:%M"),
            "sport": w["sport"], "naam": w["name"], "bron": w["source"],
            "minuten": r(minutes, 0), "km": r(km, 2), "tempo_min_km": r(pace, 2),
            "hr_gem": r(avg_hr, 0), "hr_max": r(w["max_hr"], 0), "belasting": r(trimp, 0),
            "z1": r(z[0], 0), "z2": r(z[1], 0), "z3": r(z[2], 0), "z4": r(z[3], 0), "z5": r(z[4], 0),
            "m_per_slag": r(m_per_beat, 2), "hoogtemeters": r(w["elev"], 0), "inspanning": w["effort"],
        })

    # ---- daily rows with rolling baselines
    # Start at the first day with data, so empty days before it don't dilute the baselines.
    data_days = [d for d in by_day] + [date.fromisoformat(w["datum"]) for w in workout_rows]
    first = max(min(data_days or [today]), today - timedelta(days=args.days))
    days = [first + timedelta(days=i) for i in range((today - first).days + 1)]
    daily = []
    vo2_last = None
    for d in days:
        b = by_day.get(d, {})
        hrv_vals = b.get("hrv_night") or b.get("hrv_all") or []
        hrv = statistics.mean(hrv_vals) if hrv_vals else None
        rhr = b.get("resting_heart_rate", [None])[-1] if b.get("resting_heart_rate") else None
        sl = b.get("sleep") or []
        sleep = deep = rem = core = awake = None
        if sl:
            sleep = sum(num(x.get("totalSleep")) or num(x.get("asleep")) or 0 for x in sl) or None
            deep = sum(num(x.get("deep")) or 0 for x in sl)
            rem = sum(num(x.get("rem")) or 0 for x in sl)
            core = sum(num(x.get("core")) or 0 for x in sl)
            awake = sum(num(x.get("awake")) or 0 for x in sl)
        if b.get("vo2_max"):
            vo2_last = b["vo2_max"][-1]
        kj = sum(b.get("active_energy", []))
        daily.append({
            "datum": d.isoformat(), "hrv": r(hrv), "rhr": r(rhr), "slaap_u": r(sleep, 2),
            "diep_u": r(deep, 2), "rem_u": r(rem, 2), "kern_u": r(core, 2), "wakker_u": r(awake, 2),
            "vo2max": r(b["vo2_max"][-1], 1) if b.get("vo2_max") else None,
            "vo2max_laatst": r(vo2_last, 1),
            "stappen": r(sum(b.get("step_count", [])), 0) if b.get("step_count") else None,
            "actief_kcal": r(kj / 4.184, 0) if kj else None,
            "belasting": r(load_by_day.get(d, 0.0), 0),
        })

    def window(i, key, n):
        vals = [daily[j][key] for j in range(max(0, i - n), i) if daily[j][key] is not None]
        return vals

    for i, row in enumerate(daily):
        hrv_w = [math.log(v) for v in window(i, "hrv", 28) if v and v > 0]
        rhr_w = window(i, "rhr", 28)
        row["hrv_basis"] = r(math.exp(statistics.mean(hrv_w))) if len(hrv_w) >= 5 else None
        row["hrv_sd_ln"] = statistics.stdev(hrv_w) if len(hrv_w) >= 5 else None
        row["rhr_basis"] = r(statistics.mean(rhr_w)) if len(rhr_w) >= 5 else None
        acute = sum(daily[j]["belasting"] for j in range(max(0, i - 6), i + 1))
        span = min(i + 1, 28)
        chronic_week = sum(daily[j]["belasting"] for j in range(max(0, i - 27), i + 1)) / span * 7
        row["belasting_7d"] = r(acute, 0)
        row["belasting_28d_per_week"] = r(chronic_week, 0)
        row["acwr"] = r(acute / chronic_week, 2) if chronic_week > 0 and span >= 21 else None

        # Readiness (0-100): HRV vs baseline, resting HR vs baseline, last night's sleep, load spike.
        score, parts = 60.0, 0
        if row["hrv"] and row["hrv_basis"] and row["hrv_sd_ln"]:
            zh = (math.log(row["hrv"]) - math.log(row["hrv_basis"])) / max(row["hrv_sd_ln"], 0.05)
            score += max(min(zh, 2), -2.5) * 10
            parts += 1
        if row["rhr"] and row["rhr_basis"]:
            score -= max(min(row["rhr"] - row["rhr_basis"], 8), -4) * 3
            parts += 1
        if row["slaap_u"]:
            score += max(min((row["slaap_u"] - 7.5) * 8, 10), -20)
            parts += 1
        if row["acwr"] and row["acwr"] > 1.3:
            score -= (row["acwr"] - 1.3) * 40
        row["herstel"] = r(max(0, min(100, score)), 0) if parts >= 2 else None
        del row["hrv_sd_ln"]

    # ---- weekly rows (ISO weeks, Monday)
    weeks = defaultdict(lambda: {"run_km": 0.0, "runs": 0, "lange_duurloop_km": 0.0, "kracht_sessies": 0,
                                 "kracht_min": 0.0, "hardlopen_min": 0.0, "fietsen_min": 0.0, "overig_min": 0.0,
                                 "run_z12_min": 0.0, "run_zone_min": 0.0, "belasting": 0.0})
    for w in workout_rows:
        d = date.fromisoformat(w["datum"])
        wk = (d - timedelta(days=d.weekday())).isoformat()
        k = weeks[wk]
        k["belasting"] += w["belasting"] or 0
        mins = w["minuten"] or 0
        if w["sport"] == "Hardlopen":
            k["runs"] += 1
            k["run_km"] += w["km"] or 0
            k["lange_duurloop_km"] = max(k["lange_duurloop_km"], w["km"] or 0)
            k["hardlopen_min"] += mins
            k["run_z12_min"] += (w["z1"] or 0) + (w["z2"] or 0)
            k["run_zone_min"] += sum(w[z] or 0 for z in ("z1", "z2", "z3", "z4", "z5"))
        elif w["sport"] == "Kracht":
            if mins >= 15:
                k["kracht_sessies"] += 1
            k["kracht_min"] += mins
        elif w["sport"] == "Fietsen":
            k["fietsen_min"] += mins
        else:
            k["overig_min"] += mins
    first_week = (first - timedelta(days=first.weekday()))
    week_rows = []
    wk = first_week
    while wk <= today:
        k = weeks.get(wk.isoformat()) or weeks[wk.isoformat()]
        week_rows.append({
            "week": wk.isoformat(), "weeknr": wk.isocalendar()[1],
            "run_km": r(k["run_km"], 1), "runs": k["runs"], "lange_duurloop_km": r(k["lange_duurloop_km"], 1),
            "rustig_pct": r(100 * k["run_z12_min"] / k["run_zone_min"], 0) if k["run_zone_min"] else None,
            "kracht_sessies": k["kracht_sessies"], "kracht_min": r(k["kracht_min"], 0),
            "hardlopen_min": r(k["hardlopen_min"], 0), "fietsen_min": r(k["fietsen_min"], 0),
            "overig_min": r(k["overig_min"], 0), "belasting": r(k["belasting"], 0),
            "lopend": wk + timedelta(days=6) >= today,
        })
        wk += timedelta(days=7)
    # Drop leading empty weeks before data starts.
    while week_rows and not any(week_rows[0][x] for x in ("runs", "kracht_sessies", "fietsen_min", "overig_min")):
        week_rows.pop(0)

    # ---- today's advice
    def days_since(pred):
        ds = [date.fromisoformat(w["datum"]) for w in workout_rows if pred(w)]
        return (today - max(ds)).days if ds else None

    t = daily[-1]
    y = daily[-2] if len(daily) > 1 else {}
    # Use this morning's numbers; if sleep/HRV for today is not synced yet, fall back to yesterday's.
    ready = t["herstel"] if t["herstel"] is not None else y.get("herstel")
    long_days = days_since(lambda w: w["sport"] == "Hardlopen" and (w["minuten"] or 0) >= 70)
    hard_days = days_since(lambda w: w["sport"] == "Hardlopen" and ((w["z4"] or 0) + (w["z5"] or 0)) >= 10)
    run_days = days_since(lambda w: w["sport"] == "Hardlopen")
    str_days = days_since(lambda w: w["sport"] == "Kracht" and (w["minuten"] or 0) >= 15)
    trained_today = any(w["datum"] == today.isoformat() for w in workout_rows)

    if ready is None:
        status, titel, tekst = "onbekend", "Nog geen herstelmeting", "Er is nog geen HRV of slaap van vannacht binnen. Draag je horloge vannacht en open Health Auto Export als het niet vanzelf synchroniseert."
    elif ready < 45:
        status, titel, tekst = "rood", "Hersteldag", "Je herstel ligt duidelijk onder je normaal. Houd het bij wandelen, mobiliteit of 20-30 minuten heel rustig fietsen (zone 1). Geen zware benen en geen intervallen."
    elif ready < 65:
        status = "oranje"
        if run_days is None or run_days >= 2:
            titel, tekst = "Rustige duurloop", "Matig herstel: loop 30-45 minuten in zone 2 (je moet kunnen praten). Dit bouwt je marathonbasis zonder extra vermoeidheid."
        else:
            titel, tekst = "Kracht bovenlichaam of techniek", "Matig herstel: train bovenlichaam en core, of doe lichte techniek. Spaar je benen voor je volgende loop."
    else:
        status = "groen"
        if long_days is None or long_days >= 6:
            titel, tekst = "Lange duurloop", "Goed hersteld en je lange duurloop is meer dan 5 dagen geleden. Loop rustig (zone 2) 10-20% langer dan je langste loop van de afgelopen weken."
        elif hard_days is None or hard_days >= 5:
            titel, tekst = "Kwaliteitstraining hardlopen", "Goed hersteld: tijd voor tempo of intervallen, bijvoorbeeld 5 x 4 min in zone 4 met 2 min dribbelen. Plan beentraining minstens 24 uur ervoor of erna."
        elif str_days is None or str_days >= 2:
            titel, tekst = "Zware krachttraining", "Goed hersteld: train zwaar (squat, deadlift, of push/pull) met 3-6 herhalingen per set. Doe dit liefst op een andere dag dan je lange loop of intervallen."
        else:
            titel, tekst = "Rustige duurloop of kracht", "Goed hersteld en je schema is in balans. Kies een rustige zone 2-loop van 40-60 minuten of een krachttraining voor je bovenlichaam."
    if trained_today and ready is not None:
        tekst += " Je hebt vandaag al getraind: tel dat mee."

    today_row = [{
        "datum": today.isoformat(), "herstel": ready, "status": status, "advies": titel, "uitleg": tekst,
        "hrv": t["hrv"] if t["hrv"] is not None else y.get("hrv"),
        "hrv_basis": t["hrv_basis"] or y.get("hrv_basis"),
        "rhr": t["rhr"] if t["rhr"] is not None else y.get("rhr"),
        "rhr_basis": t["rhr_basis"] or y.get("rhr_basis"),
        "slaap_u": t["slaap_u"] if t["slaap_u"] is not None else y.get("slaap_u"),
        "acwr": t["acwr"], "vo2max": t["vo2max_laatst"],
        "dagen_sinds_lange_loop": long_days, "dagen_sinds_harde_loop": hard_days,
        "dagen_sinds_kracht": str_days, "hrmax": r(hr_max, 0), "hrrust": r(hr_rest, 0),
    }]

    # ---- write
    os.makedirs(args.out, exist_ok=True)
    with open(__file__, encoding="utf-8") as f:
        code = f.read()
    meta = [
        {"label": "build_data.py", "value": code, "type": "code", "lang": "python"},
        {"label": "Input", "value": f"health_sql op {args.url}/api/mcp (metric_samples, workouts) vanaf {since}"},
        {"label": "Gemaakt", "value": datetime.now(TZ).strftime("%Y-%m-%d %H:%M %Z")},
    ]
    files = {"dagen": daily, "trainingen": workout_rows, "weken": week_rows, "vandaag": today_row}
    for name, rows in files.items():
        with open(os.path.join(args.out, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump({"rows": rows, "meta": meta}, f, ensure_ascii=False, allow_nan=False)
    if args.push_summary:
        wk = week_rows[-1] if week_rows else {}
        summary = {k: today_row[0][k] for k in ("herstel", "status", "advies", "uitleg", "hrv", "hrv_basis", "rhr", "rhr_basis", "slaap_u", "acwr", "vo2max")}
        summary.update({"datum": today.isoformat(), "week_km": wk.get("run_km"), "week_runs": wk.get("runs"),
                        "week_kracht": wk.get("kracht_sessies"), "week_rustig_pct": wk.get("rustig_pct")})
        print("summary:", json.dumps(push_summary(args.url, summary)))
    print(json.dumps({k: len(v) for k, v in files.items()} | {"hrmax": hr_max, "hrrust": hr_rest, "herstel": ready, "advies": titel}))


if __name__ == "__main__":
    sys.exit(main())
