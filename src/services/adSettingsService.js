import { getDb } from '../database/db.js';

export function getAdInterval(database = getDb()) {
  const value = Number(database.prepare('SELECT value FROM settings WHERE key=?').get('adSplashIntervalSeconds')?.value);
  return [5, 10, 15].includes(value) ? value : 5;
}

export function setAdInterval(value, database = getDb()) {
  if (![5, 10, 15].includes(value)) throw new Error('Choose 5, 10 or 15 seconds.');
  database.prepare(`INSERT INTO settings (key,value,updatedAt) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=CURRENT_TIMESTAMP`)
    .run('adSplashIntervalSeconds', String(value));
  return getAdInterval(database);
}
