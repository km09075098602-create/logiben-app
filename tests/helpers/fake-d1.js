// テスト用:Cloudflare D1 と同じ使い方ができる、メモリ上のデータベース(Node.js の node:sqlite を使う)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const clean = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
const plain = (row) => (row ? { ...row } : null);

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, clean(args));
  }
  async first() {
    return plain(this.db.prepare(this.sql).get(...this.args));
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args).map(plain) };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

/** schema.sql を読み込んだ空のデータベースを作る */
export function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
