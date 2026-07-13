import mysql from 'mysql2/promise';

/**
 * Wraps a mysql2 connection pool behind the same interface as the SQLite
 * driver (run/get/all/exec).
 */
export function createMysqlDriver({ host, port, user, password, database }) {
  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    charset: 'utf8mb4',
    timezone: 'Z',
  });

  return {
    dialect: 'mysql',

    async run(sql, params = []) {
      const [result] = await pool.execute(sql, params);
      return { insertId: result.insertId, changes: result.affectedRows };
    },

    async get(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows[0];
    },

    async all(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },

    async exec(statements) {
      for (const stmt of statements) {
        // DDL isn't prepareable in all cases — use query() instead of execute().
        await pool.query(stmt);
      }
    },

    async close() {
      await pool.end();
    },
  };
}
