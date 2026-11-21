import { and, eq, sql } from "drizzle-orm";
import { parseHaeDate } from "@/lib/hae-date";
import { metricSamples, workouts, healthEvents } from "@/db/schema";
import type { NormalizeResult } from "@/lib/ingest";

// Accepts any Drizzle db bound to our schema (neon-http in prod, PGlite in tests).
type Db = {
  insert: (...a: any[]) => any;
  delete: (...a: any[]) => any;
  select: (...a: any[]) => any;
};

export type IngestSummary = {
  metricsStored: number;
  workoutsStored: number;
  eventsStored: number;
};

// Postgres caps a single statement at 65535 bind parameters. metric_samples has
// 11 bound columns/row, so a single INSERT tops out at ~5957 rows. A first Health
// Auto Export sync sends far more, so we chunk well under that limit. 1000 rows ×
// 11 = 11000 params — safe with headroom.
const METRIC_CHUNK = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Persist normalized rows idempotently:
// - metric_samples: ON CONFLICT (metric_name,date,source) DO UPDATE (latest wins).
//   Health Auto Export re-sends an hourly bucket while the hour is still running and
//   again once it is complete; keeping the first (partial) value under-counted totals
//   such as active energy and exercise minutes.
// - workouts: ON CONFLICT (id) DO UPDATE (latest wins).
// - health_events: delete existing rows matching (event_type,date,payload) then insert,
//   since a portable jsonb-hash unique index isn't available across drivers.
// Sleep arrives as one aggregated record per night (keyed by the wake-up date). With a
// "since last sync" range Health Auto Export may send a night in pieces, each covering only
// part of it. Merge instead of overwrite: pieces that do not overlap are added together
// (earliest start, latest end, stage hours summed); overlapping ones keep the fuller piece.
const SLEEP_SUMS = ["rem", "core", "deep", "awake", "asleep", "inBed", "totalSleep"] as const;

function when(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  try {
    return parseHaeDate(v);
  } catch {
    return null;
  }
}

export function mergeSleep(
  oldExtra: Record<string, unknown> | null,
  newExtra: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!oldExtra) return newExtra;
  if (!newExtra) return oldExtra;
  const os = when(oldExtra.sleepStart), oe = when(oldExtra.sleepEnd);
  const ns = when(newExtra.sleepStart), ne = when(newExtra.sleepEnd);
  const total = (e: Record<string, unknown>) => (typeof e.totalSleep === "number" ? e.totalSleep : 0);
  if (!os || !oe || !ns || !ne) return total(newExtra) >= total(oldExtra) ? newExtra : oldExtra;
  const overlap = ns < oe && os < ne;
  if (overlap) return total(newExtra) >= total(oldExtra) ? newExtra : oldExtra;
  const first = os <= ns ? oldExtra : newExtra;
  const last = os <= ns ? newExtra : oldExtra;
  const merged: Record<string, unknown> = { ...last };
  for (const k of SLEEP_SUMS) {
    const a = typeof oldExtra[k] === "number" ? (oldExtra[k] as number) : 0;
    const b = typeof newExtra[k] === "number" ? (newExtra[k] as number) : 0;
    merged[k] = a + b;
  }
  merged.sleepStart = first.sleepStart;
  merged.inBedStart = first.inBedStart ?? first.sleepStart;
  merged.sleepEnd = last.sleepEnd;
  merged.inBedEnd = last.inBedEnd ?? last.sleepEnd;
  return merged;
}

export async function persist(db: Db, data: NormalizeResult): Promise<IngestSummary> {
  // One INSERT ... ON CONFLICT DO UPDATE may not touch the same row twice, so collapse
  // duplicate keys within a payload first (the later point wins).
  const byKey = new Map<string, (typeof data.metricRows)[number]>();
  for (const r of data.metricRows) {
    byKey.set(`${r.metricName}\u0000${r.date.toISOString()}\u0000${r.source ?? ""}`, r);
  }
  const metricRows = [...byKey.values()];
  for (const r of metricRows) {
    if (r.metricName !== "sleep_analysis" || r.source == null) continue;
    const existing = await db
      .select()
      .from(metricSamples)
      .where(
        and(
          eq(metricSamples.metricName, r.metricName),
          eq(metricSamples.date, r.date),
          eq(metricSamples.source, r.source),
        ),
      );
    if (existing.length) r.extra = mergeSleep(existing[0].extra as Record<string, unknown> | null, r.extra);
  }
  for (const batch of chunk(metricRows, METRIC_CHUNK)) {
    await db
      .insert(metricSamples)
      .values(batch)
      .onConflictDoUpdate({
        target: [metricSamples.metricName, metricSamples.date, metricSamples.source],
        set: {
          units: sql`excluded.units`,
          qty: sql`excluded.qty`,
          min: sql`excluded.min`,
          avg: sql`excluded.avg`,
          max: sql`excluded.max`,
          systolic: sql`excluded.systolic`,
          diastolic: sql`excluded.diastolic`,
          extra: sql`excluded.extra`,
        },
      });
  }

  for (const w of data.workoutRows) {
    await db
      .insert(workouts)
      .values(w)
      .onConflictDoUpdate({ target: workouts.id, set: w });
  }

  for (const e of data.eventRows) {
    await db
      .delete(healthEvents)
      .where(
        and(
          eq(healthEvents.eventType, e.eventType),
          eq(healthEvents.date, e.date),
          // jsonb semantic equality (ignores whitespace + key order), unlike a
          // ::text compare against JSON.stringify which would never match.
          sql`${healthEvents.payload} = ${JSON.stringify(e.payload)}::jsonb`,
        ),
      );
    await db.insert(healthEvents).values(e);
  }

  return {
    metricsStored: data.metricRows.length,
    workoutsStored: data.workoutRows.length,
    eventsStored: data.eventRows.length,
  };
}
