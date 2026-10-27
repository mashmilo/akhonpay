// A tiny stand-in for Cloudflare D1 built on Node's built-in SQLite (node:sqlite, Node 22+).
// Only the parts the gateway uses: prepare().bind().first()/run()/all() and batch() (atomic).
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p); }
  _st() { return this.db.prepare(this.sql); }
  async first() { const r = this._st().get(...this.params); return r ? { ...r } : null; }
  async all() { return { results: this._st().all(...this.params).map((r) => ({ ...r })), success: true }; }
  async run() { return this._runSync(); }
  _runSync() { const r = this._st().run(...this.params); return { success: true, meta: { changes: Number(r.changes) } }; }
}

export class D1Shim {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {            // D1 runs a batch as one transaction: all or nothing
    this.db.exec('BEGIN');
    try { const out = stmts.map((s) => s._runSync()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
