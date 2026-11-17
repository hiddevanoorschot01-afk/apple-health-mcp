import { and, eq, sql } from "drizzle-orm";
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
export async function persist(db: Db, data: NormalizeResult): Promise<IngestSummary> {
  // One INSERT ... ON CONFLICT DO UPDATE may not touch the same row twice, so collapse
  // duplicate keys within a payload first (the later point wins).
  const byKey = new Map<string, (typeof data.metricRows)[number]>();
  for (const r of data.metricRows) {
    byKey.set(`${r.metricName}\u0000${r.date.toISOString()}\u0000${r.source ?? ""}`, r);
  }
  const metricRows = [...byKey.values()];
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
