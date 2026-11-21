import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/db";
import { normalize } from "@/lib/ingest";
import { persist } from "@/lib/persist";
import { metricSamples, workouts, healthEvents } from "@/db/schema";

const D = "2026-06-01 08:00:00 +0000";

function payload() {
  return normalize({
    data: {
      metrics: [{ name: "step_count", units: "count", data: [{ date: D, qty: 100, source: "Watch" }] }],
      workouts: [{ id: "w1", name: "Running", start: D, end: D, duration: 1800, activeEnergyBurned: { qty: 250, units: "kcal" } }],
      ecg: [{ date: D, classification: "Sinus Rhythm" }],
      stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [],
    },
  });
}

describe("persist", () => {
  it("inserts metric, workout, and event rows", async () => {
    const db = await makeTestDb();
    const summary = await persist(db, payload());
    expect(summary).toEqual({ metricsStored: 1, workoutsStored: 1, eventsStored: 1 });
    expect(await db.select().from(metricSamples)).toHaveLength(1);
    expect(await db.select().from(workouts)).toHaveLength(1);
    expect(await db.select().from(healthEvents)).toHaveLength(1);
  });

  it("handles a large batch beyond the 65535-bind-parameter single-insert limit", async () => {
    const db = await makeTestDb();
    // 7000 metric points × ~11 columns = 77000 params > 65535: must be chunked.
    const pad = (n: number) => String(n).padStart(2, "0");
    const data = Array.from({ length: 7000 }, (_, i) => {
      const base = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60000);
      const d = `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())} ${pad(base.getUTCHours())}:${pad(base.getUTCMinutes())}:${pad(base.getUTCSeconds())} +0000`;
      return { date: d, qty: i };
    });
    const summary = await persist(db, normalize({
      data: { metrics: [{ name: "step_count", units: "count", data }],
        workouts: [], ecg: [], stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [] },
    }));
    expect(summary.metricsStored).toBe(7000);
    expect(await db.select().from(metricSamples)).toHaveLength(7000);
  });

  it("is idempotent on re-push (no duplicate rows)", async () => {
    const db = await makeTestDb();
    await persist(db, payload());
    await persist(db, payload()); // same batch again
    expect(await db.select().from(metricSamples)).toHaveLength(1);
    expect(await db.select().from(workouts)).toHaveLength(1);
    expect(await db.select().from(healthEvents)).toHaveLength(1); // event dedupe by (type,date,payload)
  });

  it("updates a metric bucket that is re-sent with a newer value", async () => {
    const db = await makeTestDb();
    const send = (qty: number) => normalize({
      data: { metrics: [{ name: "active_energy", units: "kJ", data: [{ date: D, qty, source: "Watch" }] }],
        workouts: [], ecg: [], stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [] },
    });
    await persist(db, send(85)); // partial hour
    await persist(db, send(840)); // same hour, complete
    const rows = await db.select().from(metricSamples);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].qty)).toBe(840);
  });

  it("accepts the same key twice in one payload (last one wins)", async () => {
    const db = await makeTestDb();
    await persist(db, normalize({
      data: { metrics: [{ name: "step_count", units: "count", data: [
          { date: D, qty: 10, source: "Watch" }, { date: D, qty: 20, source: "Watch" }] }],
        workouts: [], ecg: [], stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [] },
    }));
    const rows = await db.select().from(metricSamples);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].qty)).toBe(20);
  });

  it("merges a night of sleep that arrives in pieces instead of overwriting it", async () => {
    const db = await makeTestDb();
    const send = (extra: Record<string, unknown>) => normalize({
      data: { metrics: [{ name: "sleep_analysis", units: "hr", data: [{ date: "2026-11-19 00:00:00 +0100", source: "Watch", ...extra }] }],
        workouts: [], ecg: [], stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [] },
    });
    await persist(db, send({ sleepStart: "2026-11-18 22:26:00 +0100", sleepEnd: "2026-11-19 02:00:00 +0100", deep: 0.5, core: 2, rem: 0.8, awake: 0.1, totalSleep: 3.3 }));
    await persist(db, send({ sleepStart: "2026-11-19 02:00:00 +0100", sleepEnd: "2026-11-19 06:15:00 +0100", deep: 0.4, core: 2.6, rem: 1.1, awake: 0.2, totalSleep: 4.1 }));
    const rows = await db.select().from(metricSamples);
    expect(rows).toHaveLength(1);
    const ex = rows[0].extra as Record<string, number | string>;
    expect(ex.sleepStart).toBe("2026-11-18 22:26:00 +0100");
    expect(ex.sleepEnd).toBe("2026-11-19 06:15:00 +0100");
    expect(ex.totalSleep).toBeCloseTo(7.4);
  });

  it("keeps the fuller sleep record when a re-sent piece overlaps it", async () => {
    const db = await makeTestDb();
    const send = (extra: Record<string, unknown>) => normalize({
      data: { metrics: [{ name: "sleep_analysis", units: "hr", data: [{ date: "2026-11-19 00:00:00 +0100", source: "Watch", ...extra }] }],
        workouts: [], ecg: [], stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [] },
    });
    await persist(db, send({ sleepStart: "2026-11-18 22:26:00 +0100", sleepEnd: "2026-11-19 06:15:00 +0100", totalSleep: 7.4 }));
    await persist(db, send({ sleepStart: "2026-11-19 04:04:00 +0100", sleepEnd: "2026-11-19 06:15:00 +0100", totalSleep: 2.1 }));
    const ex = (await db.select().from(metricSamples))[0].extra as Record<string, number>;
    expect(ex.totalSleep).toBe(7.4);
  });
});
