import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database verification.");
const db = postgres(process.env.DATABASE_URL, { max: 4, prepare: false, connect_timeout: 10, onnotice() {}, connection: { statement_timeout: 15000, lock_timeout: 5000 } });
// Only this suite's generated schema is committed, to exercise independent
// concurrent transactions. It contains no Auth identities or patient records.
const schema = "hms_quota_verify_" + randomUUID().replaceAll("-", "");
const table = '"' + schema + '".provider_request_budgets';
let scope: string;
const reserve = async (provider = "whoop") => {
  const [row] = await db.unsafe('select "' + schema + '".reserve_provider_request($1,$2)::text retry_at', [provider, scope]);
  return row.retry_at as string | null;
};

describe("real Postgres: private shared provider budgets", () => {
  beforeAll(async () => {
    await db.unsafe('create schema "' + schema + '"');
    const ddl = readFileSync("drizzle/0042_provider_request_budgets.sql", "utf8").replaceAll("hms_private", schema);
    await db.begin(async tx => {
      for (const statement of ddl.split("--> statement-breakpoint")) if (statement.trim()) await tx.unsafe(statement);
    });
  });
  beforeEach(() => { scope = createHash("sha256").update(randomUUID()).digest("hex"); });
  afterAll(async () => {
    try {
      if (!/^hms_quota_verify_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid isolated cleanup scope.");
      await db.unsafe('drop schema if exists "' + schema + '" cascade');
    } finally { await db.end(); }
  });

  it("enforces and forces RLS without storing an account or patient identifier", async () => {
    const [row] = await db.unsafe("select c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname='provider_request_budgets'", [schema]);
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const columns = await db.unsafe("select column_name from information_schema.columns where table_schema=$1 and table_name='provider_request_budgets' order by ordinal_position", [schema]);
    expect(columns.map(c => c.column_name)).toEqual(["provider", "scope_hash", "credits", "refilled_at", "blocked_until"]);
  });

  it.each(["anon", "authenticated", "service_role"])("denies budget reads and function execution to %s", async role => {
    await expect(db.begin(async tx => {
      // Grant only schema USAGE to isolate the table/function ACL boundary.
      await tx.unsafe('grant usage on schema "' + schema + '" to ' + role);
      await tx.unsafe("set local role " + role);
      await tx.unsafe("select * from " + table);
    })).rejects.toMatchObject({ code: "42501" });
    for (const call of ["reserve_provider_request($1,$2)", "defer_provider_requests($1,$2,clock_timestamp()+interval '1 hour')"]) {
      await expect(db.begin(async tx => {
        await tx.unsafe('grant usage on schema "' + schema + '" to ' + role);
        await tx.unsafe("set local role " + role);
        await tx.unsafe('select "' + schema + '".' + call, ["whoop", scope]);
      })).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("permits the WHOOP burst once and does not debit denied requests", async () => {
    const rows = await db.unsafe('select "' + schema + '".reserve_provider_request(\'whoop\',$1)::text retry_at from generate_series(1,15)', [scope]);
    expect(rows.filter(row => row.retry_at === null)).toHaveLength(10);
    expect(rows.filter(row => row.retry_at !== null)).toHaveLength(5);
    const [row] = await db.unsafe("select credits::float8 credits,extract(epoch from (refilled_at-clock_timestamp()))::float8 skew from " + table + " where provider='whoop' and scope_hash=$1", [scope]);
    expect(row.credits).toBeGreaterThanOrEqual(0);
    expect(row.credits).toBeLessThan(1);
    expect(Math.abs(row.skew)).toBeLessThan(2);
  });

  it("serialises concurrent callers at the last shared Google permit", async () => {
    // A future refill timestamp freezes replenishment without a production
    // clock override, so connection latency cannot create extra test permits.
    await db.unsafe("insert into " + table + "(provider,scope_hash,credits,refilled_at) values('google_health',$1,1,clock_timestamp()+interval '10 minutes')", [scope]);
    const attempts = await Promise.all(Array.from({ length: 12 }, () => reserve("google_health")));
    expect(attempts.filter(result => result === null)).toHaveLength(1);
    expect(attempts.filter(result => result !== null)).toHaveLength(11);
    const [row] = await db.unsafe("select credits::float8 credits from " + table + " where provider='google_health' and scope_hash=$1", [scope]);
    expect(row.credits).toBe(0);
  });

  it("refills at the conservative WHOOP rate using database time", async () => {
    await db.unsafe("insert into " + table + "(provider,scope_hash,credits,refilled_at) values('whoop',$1,0,clock_timestamp()-interval '10 seconds')", [scope]);
    expect(await reserve()).toBeNull();
    const [row] = await db.unsafe("select credits::float8 credits from " + table + " where provider='whoop' and scope_hash=$1", [scope]);
    expect(row.credits).toBeGreaterThanOrEqual(10 * 9000 / 86400 - 1);
    expect(row.credits).toBeLessThan(0.5);
  });

  it("bounds long-idle refill instead of accumulating unbounded credit", async () => {
    await db.unsafe("insert into " + table + "(provider,scope_hash,credits,refilled_at) values('whoop',$1,0,clock_timestamp()-interval '30 days')", [scope]);
    expect(await reserve()).toBeNull();
    const [row] = await db.unsafe("select credits::float8 credits from " + table + " where provider='whoop' and scope_hash=$1", [scope]);
    expect(row.credits).toBe(9);
  });

  it("persists the longest cooldown across concurrent callers without replenishing permits", async () => {
    expect(await reserve()).toBeNull();
    const [deadlines] = await db.unsafe("select (clock_timestamp()+interval '2 hours')::text later,(clock_timestamp()+interval '1 hour')::text earlier");
    await Promise.all([deadlines.later, deadlines.earlier].map(value => db.unsafe('select "' + schema + '".defer_provider_requests($1,$2,$3::text::timestamptz)', ["whoop", scope, String(value)])));
    const [stored] = await db.unsafe("select blocked_until::text,credits::float8 credits from " + table + " where provider='whoop' and scope_hash=$1", [scope]);
    expect(stored).toEqual({ blocked_until: deadlines.later, credits: 9 });
    expect(await reserve()).toBe(deadlines.later);
    // Another caller, grant or process cannot bypass this scope's stored block.
    expect(await reserve()).toBe(deadlines.later);
  });

  it("ignores an expired cooldown and still consumes the retained budget", async () => {
    await db.unsafe("insert into " + table + "(provider,scope_hash,credits,refilled_at,blocked_until) values('whoop',$1,2,clock_timestamp()+interval '1 hour',clock_timestamp()-interval '1 second')", [scope]);
    expect(await reserve()).toBeNull();
    const [row] = await db.unsafe("select credits::float8 credits from " + table + " where provider='whoop' and scope_hash=$1", [scope]);
    expect(row.credits).toBe(1);
  });

  it("rejects invalid scopes, provider names and infinite cooldowns", async () => {
    await expect(db.unsafe('select "' + schema + '".reserve_provider_request($1,$2)', ["whoop", "not-a-digest"])).rejects.toMatchObject({ code: "22023" });
    await expect(reserve("unknown")).rejects.toMatchObject({ code: "22023" });
    await expect(db.unsafe('select "' + schema + '".defer_provider_requests($1,$2,\'infinity\')', ["whoop", scope])).rejects.toMatchObject({ code: "22023" });
  });
});
