import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

import { runSeed } from '../src/seed';
import { applyMigrations, persistInfraEnv, startInfra } from './containers';

declare global {
  var __BORDERLESS_INFRA_STOP__: (() => Promise<void>) | undefined;
}

export default async function globalSetup(): Promise<void> {
  const infra = await startInfra();

  applyMigrations(infra.databaseUrl);

  // The app refuses to boot without an active USDx in the currency table, so the
  // seed is part of setting up a usable test database, not an optional extra.
  const prisma = new PrismaClient({ datasources: { db: { url: infra.databaseUrl } } });
  try {
    await runSeed(prisma, false);
  } finally {
    await prisma.$disconnect();
  }

  /*
   * Start from an empty cache.
   *
   * The FX chain reads Redis before any provider, so a rate table left behind by
   * a previous run -- or by a developer running the app against the same Redis --
   * would be served instead of the fixture the suite seeded, and every converted
   * amount would silently assert against the wrong number. This is exactly what
   * happened the first time: real live rates leaked in and the expectations
   * looked arbitrary.
   *
   * TEST_REDIS_URL is therefore documented as pointing at a disposable instance:
   * a testcontainer locally, a service container in CI.
   */
  const redis = new Redis(infra.redisUrl);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }

  process.env.DATABASE_URL = infra.databaseUrl;
  process.env.REDIS_URL = infra.redisUrl;
  process.env.BORDERLESS_INFRA_FILE = persistInfraEnv(infra);

  globalThis.__BORDERLESS_INFRA_STOP__ = infra.stop;
}
