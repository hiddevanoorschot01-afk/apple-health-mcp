# Hybrid Training dashboard

`build_data.py` reads your Apple Health data from this server's `health_sql` tool and
writes the JSON files behind the Hybrid Training dashboard (a Claude "Data" artifact):

| File | Rows |
|---|---|
| `dagen.json` | per day: HRV, resting HR, sleep stages, VO2max, training load, ACWR, readiness score |
| `trainingen.json` | per workout (duplicates from SportCity/Motra/Strava merged): duration, km, pace, HR zones, TRIMP |
| `weken.json` | per ISO week: running km, long run, % easy running, strength sessions, minutes per sport |
| `vandaag.json` | today's readiness and suggested session |

```bash
MCP_SECRET=... python3 dashboard/build_data.py --out dashboard/out
```

A scheduled Claude session runs it every morning, adds coaching notes (`coach.json`)
and uploads the files to the dashboard. Output goes to a git-ignored folder: health
data never lands in this repo.

Assumptions: HR max = highest workout HR seen, HR rest = median resting HR; zones by
heart-rate reserve (Z1 <60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 >90%); load = Banister TRIMP
per minute; readiness = 60 ± HRV vs 28-day baseline, resting HR vs baseline, sleep vs 7.5 h,
minus a penalty above ACWR 1.3.
