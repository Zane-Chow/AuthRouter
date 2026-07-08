import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * Wraps better-sqlite3 (synchronous) behind the same async interface as the
 * MySQL driver, so calling code can `await` uniformly regardless of backend.
 */
export function createSqliteDriver(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'sso.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return {
    dialect: 'sqlite',

    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { insertId: info.lastInsertRowid, changes: info.changes };
    },

    async get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },

    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },

    async exec(statements) {
      for (const stmt of statements) {
        db.exec(stmt);
      }
    },

    async close() {
      db.close();
    },
  };
}
