import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

export interface TestInfra {
  databaseUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
}

/**
 * Tests run against real Postgres and real Redis — never fakes.
 * Row-level locking, unique-constraint races and `FOR UPDATE` semantics are the
 * things most worth testing here, and none of them exist in an in-memory double.
 *
 * CI supplies TEST_DATABASE_URL / TEST_REDIS_URL (service containers) and we use
 * those; locally we start throwaway containers so `yarn test` needs no setup.
 */
export async function startInfra(): Promise<TestInfra> {
  const providedDb = process.env.TEST_DATABASE_URL;
  const providedRedis = process.env.TEST_REDIS_URL;

  if (providedDb && providedRedis) {
    return { databaseUrl: providedDb, redisUrl: providedRedis, stop: async () => {} };
  }

  let pg: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;

  const databaseUrl =
    providedDb ??
    (await (async () => {
      pg = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('borderless_test')
        .withUsername('borderless')
        .withPassword('borderless')
        .start();
      return `${pg.getConnectionUri()}?schema=public`;
    })());

  const redisUrl =
    providedRedis ??
    (await (async () => {
      redis = await new RedisContainer('redis:7-alpine').start();
      return redis.getConnectionUrl();
    })());

  return {
    databaseUrl,
    redisUrl,
    stop: async () => {
      await Promise.all([pg?.stop(), redis?.stop()]);
    },
  };
}

/** Applies the committed migrations to a freshly started database. */
export function applyMigrations(databaseUrl: string): void {
  execFileSync('yarn', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

/** Writes the resolved connection strings where every worker process can read them. */
export function persistInfraEnv(infra: Pick<TestInfra, 'databaseUrl' | 'redisUrl'>): string {
  const file = join(mkdtempSync(join(tmpdir(), 'borderless-test-')), 'infra.json');
  writeFileSync(file, JSON.stringify(infra));
  return file;
}
