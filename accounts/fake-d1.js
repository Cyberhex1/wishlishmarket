// In-memory SQLite stand-in for Cloudflare D1, for tests and the local browser
// test server (Node 22+): prepare().bind().first/all/run, batch.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function fakeD1() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  sql.exec(fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async col => { const r = sql.prepare(q).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ success: true, results: sql.prepare(q).all(...args).map(r => ({ ...r })), meta: {} }),
    run: async () => { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    sql,
    prepare: q => stmt(q),
    batch: async list => {
      sql.exec("BEGIN");
      try { const out = []; for (const s of list) out.push(await s.run()); sql.exec("COMMIT"); return out; }
      catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
  };
}

