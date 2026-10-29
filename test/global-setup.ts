import { applyMigrations, persistInfraEnv, startInfra } from './containers';

declare global {
  var __CARDTONIC_INFRA_STOP__: (() => Promise<void>) | undefined;
}

export default async function globalSetup(): Promise<void> {
  const infra = await startInfra();

  applyMigrations(infra.databaseUrl);

  process.env.DATABASE_URL = infra.databaseUrl;
  process.env.REDIS_URL = infra.redisUrl;
  process.env.CARDTONIC_INFRA_FILE = persistInfraEnv(infra);

  globalThis.__CARDTONIC_INFRA_STOP__ = infra.stop;
}
