import 'reflect-metadata';
import { readFileSync } from 'node:fs';

// globalSetup runs in a different process to the test workers, so the resolved
// connection strings are handed over through a temp file rather than env mutation.
const file = process.env.BORDERLESS_INFRA_FILE;
if (file) {
  const infra = JSON.parse(readFileSync(file, 'utf8')) as {
    databaseUrl: string;
    redisUrl: string;
  };
  process.env.DATABASE_URL = infra.databaseUrl;
  process.env.REDIS_URL = infra.redisUrl;
}

process.env.NODE_ENV = 'test';

// The FX provider is pointed somewhere unroutable so the suite never depends on
// a third party being up, never pays its latency, and exercises the fallback
// chain. Caching is off so each request resolves through the chain rather than
// through a table a previous test warmed.
process.env.FX_PROVIDER_URL = 'http://127.0.0.1:9/unreachable-by-design';
process.env.FX_PROVIDER_TIMEOUT_MS = '150';
process.env.FX_CACHE_TTL_SECONDS = '0';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdefghij';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdefghij';
