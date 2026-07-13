import config from '../config.js';
import { createSqliteDriver } from './sqlite-driver.js';
import { createMysqlDriver } from './mysql-driver.js';
import { sqliteSchema, mysqlSchema, sqliteIndexes } from './schema.js';

let driverPromise = null;

async function init() {
  const driver = config.db.driver === 'mysql'
    ? createMysqlDriver(config.db.mysql)
    : createSqliteDriver(config.dataDir);

  const schema = driver.dialect === 'mysql' ? mysqlSchema : sqliteSchema;
  await driver.exec(Object.values(schema));

  if (driver.dialect === 'sqlite') {
    await driver.exec(sqliteIndexes);
  }

  console.log(`✅ Database initialized (driver: ${driver.dialect})`);
  return driver;
}

/**
 * Get the shared database driver (sqlite or mysql, per config.db.driver).
 * Lazily initialized once; schema is created on first call.
 * @returns {Promise<{dialect: string, run: Function, get: Function, all: Function, exec: Function}>}
 */
export async function getDb() {
  if (!driverPromise) {
    driverPromise = init().catch((error) => {
      driverPromise = null;
      throw error;
    });
  }
  return driverPromise;
}

export async function closeDb() {
  if (!driverPromise) return;
  const driver = await driverPromise;
  driverPromise = null;
  await driver.close();
}
