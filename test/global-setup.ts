import { applyMigrations, persistInfraEnv, startInfra } from './containers';

declare global {
  var __BORDERLESS_INFRA_STOP__: (() => Promise<void>) | undefined;
}

export default async function globalSetup(): Promise<void> {
  const infra = await startInfra();

  applyMigrations(infra.databaseUrl);

  process.env.DATABASE_URL = infra.databaseUrl;
  process.env.REDIS_URL = infra.redisUrl;
  process.env.BORDERLESS_INFRA_FILE = persistInfraEnv(infra);

  globalThis.__BORDERLESS_INFRA_STOP__ = infra.stop;
}
