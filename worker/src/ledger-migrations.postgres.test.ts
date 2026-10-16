/** Opt-in, disposable LOCAL PostgreSQL only. Never reads DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { makePgDb, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { applyLedgerMigrations } from "./ledger-migrations";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

test("Postgres: repeated ledger setup does not queue exclusive locks behind public reads", { skip: !url, timeout: 60_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local PostgreSQL is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const schema = `mm_migration_lock_${randomBytes(8).toString("hex")}`;
  const shadow = `${schema}_shadow`;
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const scoped = (who: string, searchPath = schema) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${searchPath} -c statement_timeout=5000 -c lock_timeout=500`);
    u.searchParams.set("application_name", `ledger-migration-test-${who}`);
    return u.toString();
  };
  const reader = new pg.Client({ connectionString: scoped("reader") });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE SCHEMA ${shadow}`);
  try {
    await reader.connect();
    const db = await makePgDb(scoped("migrator"));
    await applyLedgerSchema(db);

    await t.test("a held AccessShareLock permits the entire no-op schema pass, with no ADD COLUMN issued", async () => {
      await reader.query("BEGIN");
      await reader.query("SELECT smart_account FROM agents LIMIT 1");
      const alters: string[] = [];
      const observed: Db = {
        prepare: sql => db.prepare(sql), tx: fn => db.tx(fn),
        exec: async sql => { if (/^ALTER TABLE/i.test(sql)) alters.push(sql); await db.exec(sql); },
      };
      try {
        // Before the catalog guard the first existing agents column waited
        // for this reader's transaction, then hit lock_timeout. Every pass did it.
        await applyLedgerSchema(observed);
        assert.deepEqual(alters, []);
        assert.equal((await reader.query("SELECT COUNT(*) AS n FROM agents")).rows.length, 1);
      } finally { await reader.query("ROLLBACK"); }
    });

    await t.test("missing required columns still migrate, and a lock failure cannot be swallowed", async () => {
      await db.exec("ALTER TABLE agents DROP COLUMN hwm_withdrawn_usdg");
      await reader.query("BEGIN");
      await reader.query("SELECT smart_account FROM agents LIMIT 1");
      try {
        await assert.rejects(applyLedgerSchema(db), error => (error as { code?: string }).code === "55P03");
      } finally { await reader.query("ROLLBACK"); }
      await applyLedgerSchema(db);
      const column = await db.prepare(`SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'hwm_withdrawn_usdg'`).get() as Record<string, unknown>;
      assert.equal(column.is_nullable, "NO");
      assert.match(String(column.column_default), /0/);
    });

    await t.test("catalog lookup honors search-path shadowing rather than a namesake in another schema", async () => {
      await admin.query(`CREATE TABLE ${shadow}.agents (id TEXT, peak DOUBLE PRECISION NOT NULL DEFAULT 0)`);
      await db.exec("CREATE TABLE catalog_probe (id TEXT)");
      await admin.query(`CREATE TABLE ${shadow}.catalog_probe (id TEXT, peak DOUBLE PRECISION NOT NULL DEFAULT 0)`);
      const visible = await makePgDb(scoped("shadow", `${schema},${shadow}`));
      await applyLedgerMigrations(visible, ["ALTER TABLE catalog_probe ADD COLUMN peak REAL NOT NULL DEFAULT 0"]);
      const columns = await visible.prepare(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'catalog_probe'`).all() as { column_name: string }[];
      assert.ok(columns.some(c => c.column_name === "peak"));
    });

    await t.test("two initializers that both see a missing column complete safely", async () => {
      await db.exec("CREATE TABLE concurrent_probe (id TEXT)");
      const other = await makePgDb(scoped("other"));
      let catalogs = 0;
      let release!: () => void;
      const bothRead = new Promise<void>(resolve => { release = resolve; });
      const synchronizedCatalog = (base: Db): Db => ({
        exec: sql => base.exec(sql), tx: fn => base.tx(fn),
        prepare(sql) {
          const stmt = base.prepare(sql);
          if (!sql.includes("pg_catalog.pg_attribute")) return stmt;
          return { ...stmt, all: async (...params) => {
            const rows = await stmt.all(...params);
            if (++catalogs === 2) release();
            await bothRead;
            return rows;
          } };
        },
      });
      const migration = ["ALTER TABLE concurrent_probe ADD COLUMN peak REAL NOT NULL DEFAULT 7"];
      await Promise.all([applyLedgerMigrations(synchronizedCatalog(db), migration), applyLedgerMigrations(synchronizedCatalog(other), migration)]);
      await db.prepare("INSERT INTO concurrent_probe (id) VALUES (?)").run("row");
      assert.deepEqual(await db.prepare("SELECT peak FROM concurrent_probe").get(), { peak: 7 });
    });
  } finally {
    await reader.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP SCHEMA ${shadow} CASCADE`);
    await admin.end();
  }
});
