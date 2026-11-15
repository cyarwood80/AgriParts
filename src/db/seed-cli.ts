import { loadConfig } from '../config.js';
import { openDatabase } from './client.js';
import { seedDemo } from './seed.js';

const database = await openDatabase(loadConfig().databaseUrl);
const { keys } = await seedDemo(database.db, { log: console.log });
console.log('\nDemo API keys (shown once):');
for (const [name, key] of Object.entries(keys)) console.log(`  ${name.padEnd(9)} ${key}`);
await database.close();
