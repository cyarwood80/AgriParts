import { randomBytes } from 'node:crypto';

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  autoMigrate: boolean;
  seedDemo: boolean;
  confirmSecret: string;
  dispatcherIntervalMs: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const confirmSecret = env.AGRIPARTS_CONFIRM_SECRET ?? (env.NODE_ENV === 'production' ? undefined : randomBytes(32).toString('hex'));
  if (!confirmSecret) throw new Error('AGRIPARTS_CONFIRM_SECRET must be set in production');
  return {
    databaseUrl: env.DATABASE_URL ?? 'pglite://./.data/agriparts',
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    autoMigrate: env.AUTO_MIGRATE !== 'false',
    seedDemo: env.SEED_DEMO === 'true',
    confirmSecret,
    dispatcherIntervalMs: Number(env.DISPATCHER_INTERVAL_MS ?? 2000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
