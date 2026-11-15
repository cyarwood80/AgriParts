import { loadConfig } from '../config.js';
import { openDatabase } from './client.js';

const db = await openDatabase(loadConfig().databaseUrl, { migrate: true });
console.log(`Migrations applied (${db.driver}).`);
await db.close();
