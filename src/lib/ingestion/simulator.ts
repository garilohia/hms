import { BATCH_SIZE, canonicalMetric, units, type DataSource, type DataSourceAdapter, type IngestionTransport, type MetricType, type NormalisedMetric } from "./model";

export const personas = {
  a: { name: "Sample data · Arun, 34", age: 34, sex: "male" },
  b: { name: "Sample data · Meera, 42", age: 42, sex: "female" },
  c: { name: "Sample data · Dev, 61", age: 61, sex: "male" },
} as const;
export type Persona = keyof typeof personas;
export function* sampleMetrics(persona: Persona, seed = 42, endDay = new Date().toISOString().slice(0, 10)): Generator<NormalisedMetric> {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const end = Date.parse(endDay + "T00:00:00Z");
  if (!Number.isFinite(end)) throw new Error("A valid sample end day is required.");
  for (let day = 0; day < 90; day++) {
    const time = end - (89 - day) * 86400000;
    const phase = day % 28;
    const luteal = persona === "b" && phase >= 15;
    const fever = persona === "c" && day >= 87;
    const shift = luteal ? 0.36 : fever ? 1.25 : 0;
    const noise = () => (random() - .5) * 2;
    const make = (metric_type: MetricType, value: number, hour = 6, duration_s: number | null = null, quality: NormalisedMetric["quality"] = "raw"): NormalisedMetric => ({
      metric_type, value: Number(value.toFixed(3)), unit: units[metric_type], recorded_at: new Date(time + hour * 3600000).toISOString(),
      duration_s, quality, external_id: "sample:" + persona + ":" + day + ":" + metric_type + ":" + hour,
    });
    yield make("resting_heart_rate", (persona === "c" ? 73 : 60) + (luteal ? 4 : fever ? 10 : 0) + noise() * 2, 6, 1800);
    yield make("hrv_rmssd", (persona === "c" ? 29 : 54) - (luteal || fever ? 9 : 0) + noise() * 5);
    yield make("skin_temperature", 33.4 + shift + noise() * .06, 1, 10800);
    yield make("sleep_duration", 450 + noise() * 25 - (fever ? 85 : 0), 7);
    yield make("sleep_stage", 3, 0, 5400);
    yield make("sleep_stage", 2, 1.5, 14400);
    yield make("sleep_stage", 4, 5.5, 5400);
    yield make("steps", Math.round(7800 + noise() * 1500 - (fever ? 4500 : 0)), 20);
    yield make("active_calories", 380 + noise() * 70 - (fever ? 200 : 0), 20);
    yield make("stress_score", 30 + noise() * 10 + (fever ? 35 : 0));
    yield make("weight_kg", (persona === "b" ? 62 : persona === "c" ? 85 : 74) + noise() * .4);
    yield make("respiratory_rate", 15 + noise());
    yield make("blood_pressure_systolic", persona === "c" ? 145 + noise() * 8 : 117 + noise() * 4, 8, null, "user_entered");
    yield make("blood_pressure_diastolic", persona === "c" ? 92 + noise() * 4 : 76 + noise() * 3, 8, null, "user_entered");
    if (persona === "b" && phase < 5) yield make("menstrual_flow", phase === 0 ? 3 : 2, 8, null, "user_entered");
    // Continuous one-minute night samples, including ten minutes below 90% and
    // a full 35 minutes below 92%. Explicit durations avoid inferred continuity.
    for (let minute = 0; minute < 35; minute++) {
      yield make("spo2", persona === "c" && day === 89 ? (minute < 12 ? 88 : 91) : 97 + noise(), 2 + minute / 60, 60);
      yield make("heart_rate", (persona === "c" ? 72 : 59) + noise() * 2, 2 + minute / 60, 60);
    }
  }
}

export class SimulatorAdapter implements DataSourceAdapter {
  readonly provider = "simulator";
  constructor(private transport: IngestionTransport, readonly persona: Persona = "a", readonly seed = 42, readonly endDay?: string) {}
  connect(userId: string, _input: unknown) { void _input; return this.transport.connect(userId, this.provider, "Sample data · " + this.persona); }
  normalise(raw: unknown) { return canonicalMetric(raw); }
  async sync(source: DataSource) {
    const result = { inserted: 0, skipped: 0, errors: [] as string[] };
    let batch: NormalisedMetric[] = [];
    const flush = async () => {
      const counts = await this.transport.persist(source, batch);
      result.inserted += counts.inserted; result.skipped += counts.skipped; batch = [];
    };
    for (const raw of sampleMetrics(this.persona, this.seed, this.endDay)) {
      batch.push(...this.normalise(raw));
      if (batch.length === BATCH_SIZE) await flush();
    }
    if (batch.length) await flush();
    return result;
  }
}
