import type { DataSource, DataSourceAdapter, NormalisedMetric, SyncResult } from "./model";

export class AggregatorAdapter implements DataSourceAdapter {
  readonly provider = "aggregator";
  async connect(_userId: string, _input: unknown): Promise<DataSource> {
    void _userId; void _input;
    throw new Error("Coming soon. A provider agreement and credentials are required.");
  }
  async sync(_source: DataSource): Promise<SyncResult> { void _source; return { inserted: 0, skipped: 0, errors: ["Aggregator integration is not configured."] }; }
  normalise(_raw: unknown): NormalisedMetric[] {
    void _raw;
    // TODO: Map the contracted provider's documented payload after agreement.
    return [];
  }
}
