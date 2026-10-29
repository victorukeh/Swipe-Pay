import type { ConfigService } from '@nestjs/config';

import type { EnvSchema } from '../config/env.schema';
import type { CurrencyRegistry } from '../money/currency-registry.service';
import type { CurrencyMeta } from '../money/currency.types';

import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-code';
import { MoneyUtil } from '../money/money.util';
import type { RedisService } from '../redis/redis.service';
import { FxService } from './fx.service';
import type { FxRateProvider, RateSourceName, RateTable } from './fx.types';
import type { SnapshotFxProvider } from './providers/snapshot-fx.provider';

const ASOF = new Date('2026-10-29T08:00:00.000Z');

function meta(code: string, peg: string, decimals: number, sortOrder: string): CurrencyMeta {
  return { code, peg, decimals, name: code, minorUnit: 'unit', isActive: true, sortOrder };
}

const cNGN = meta('cNGN', 'NGN', 2, '0.1');
const cGHS = meta('cGHS', 'GHS', 2, '0.2');
const cXAF = meta('cXAF', 'XAF', 0, '0.3');
const USDx = meta('USDx', 'USD', 6, '0.4');
const EURx = meta('EURx', 'EUR', 6, '0.5');
const ALL = [cNGN, cGHS, cXAF, USDx, EURx];

/**
 * A registry backed by fixed rows instead of the database.
 *
 * FxService only ever asks the registry for metadata, never for a connection,
 * which is what makes this substitution sufficient — and is the reason the
 * registry is injected rather than imported.
 */
function fakeRegistry(currencies: readonly CurrencyMeta[] = ALL): CurrencyRegistry {
  const byCode = new Map(currencies.map((c) => [c.code, c]));
  return {
    all: () => currencies,
    codes: () => currencies.map((c) => c.code),
    find: (code: string) => byCode.get(code),
    require: (code: string) => byCode.get(code)!,
    usd: () => byCode.get('USDx')!,
    findByPeg: (peg: string) => currencies.find((c) => c.peg === peg),
    pairs: () => currencies.flatMap((from) => currencies.map((to) => [from, to] as const)),
  } as unknown as CurrencyRegistry;
}

function table(source: RateSourceName, asOf = ASOF): RateTable {
  return {
    perUsd: {
      USD: MoneyUtil.rateFromString('1'),
      NGN: MoneyUtil.rateFromString('1600'),
      GHS: MoneyUtil.rateFromString('16'),
      XAF: MoneyUtil.rateFromString('625'),
      EUR: MoneyUtil.rateFromString('0.92'),
    },
    asOf,
    source,
  };
}

/** A provider that is substitutable for any other — the point of the interface. */
function provider(name: string, result: RateTable | null): FxRateProvider {
  return { name, fetch: jest.fn<Promise<RateTable | null>, []>().mockResolvedValue(result) };
}

function failingProvider(name: string): FxRateProvider {
  return { name, fetch: jest.fn<Promise<RateTable | null>, []>().mockResolvedValue(null) };
}

/** An in-memory stand-in for Redis, so the cache behaviour is observable. */
function fakeRedis(): RedisService & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    setEx: (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    del: (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return Promise.resolve();
    },
  } as unknown as RedisService & { store: Map<string, string> };
}

function fakeSnapshots(): SnapshotFxProvider & { persist: jest.Mock } {
  return { persist: jest.fn().mockResolvedValue(undefined) } as unknown as SnapshotFxProvider & {
    persist: jest.Mock;
  };
}

type EnvConfig = ConfigService<EnvSchema, true>;

function config(overrides: Record<string, unknown> = {}): EnvConfig {
  const values: Record<string, unknown> = { FX_CACHE_TTL_SECONDS: 300, ...overrides };
  return { get: (key: string) => values[key] } as unknown as EnvConfig;
}

function build(
  providers: readonly FxRateProvider[],
  opts: {
    redis?: ReturnType<typeof fakeRedis>;
    snapshots?: ReturnType<typeof fakeSnapshots>;
    ttl?: number;
    currencies?: readonly CurrencyMeta[];
  } = {},
) {
  const redis = opts.redis ?? fakeRedis();
  const snapshots = opts.snapshots ?? fakeSnapshots();
  const service = new FxService(
    providers,
    snapshots,
    fakeRegistry(opts.currencies),
    redis,
    config(opts.ttl === undefined ? {} : { FX_CACHE_TTL_SECONDS: opts.ttl }),
  );
  return { service, redis, snapshots };
}

describe('FxService provider chain', () => {
  it('uses the live provider when it answers', async () => {
    const { service, snapshots } = build([provider('live', table('live'))]);

    const result = await service.getTable();

    expect(result.source).toBe('live');
    expect(result.asOf).toEqual(ASOF);
    // A successful live fetch becomes the new last-known-good.
    expect(snapshots.persist).toHaveBeenCalledTimes(1);
  });

  it('falls back to the snapshot when the live provider is down', async () => {
    const live = failingProvider('live');
    const { service, snapshots } = build([live, provider('snapshot', table('stale'))]);

    const result = await service.getTable();

    expect(live.fetch).toHaveBeenCalled();
    expect(result.source).toBe('stale');
    // A snapshot is not re-persisted; it is already the durable copy.
    expect(snapshots.persist).not.toHaveBeenCalled();
  });

  it('falls back to the static table when live and snapshot both fail', async () => {
    const { service } = build([
      failingProvider('live'),
      failingProvider('snapshot'),
      provider('static', table('fallback')),
    ]);

    const result = await service.getTable();
    expect(result.source).toBe('fallback');
  });

  it('raises RATE_UNAVAILABLE only when every tier fails', async () => {
    const { service } = build([
      failingProvider('live'),
      failingProvider('snapshot'),
      failingProvider('static'),
    ]);

    await expect(service.getTable()).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.RATE_UNAVAILABLE }),
    );
  });

  it('does not consult the next provider once one answers', async () => {
    const snapshot = failingProvider('snapshot');
    const { service } = build([provider('live', table('live')), snapshot]);

    await service.getTable();
    expect(snapshot.fetch).not.toHaveBeenCalled();
  });
});

describe('FxService caching', () => {
  it('serves a second call from Redis without re-fetching', async () => {
    const live = provider('live', table('live'));
    const { service } = build([live]);

    await service.getTable();
    const second = await service.getTable();

    expect(live.fetch).toHaveBeenCalledTimes(1);
    // A cached live rate is no longer live, and says so.
    expect(second.source).toBe('cached');
    expect(second.asOf).toEqual(ASOF);
  });

  it('preserves rate precision through the cache round trip', async () => {
    const live = provider('live', table('live'));
    const { service } = build([live]);

    const direct = await service.resolveRate(cNGN, EURx);
    const cached = await service.resolveRate(cNGN, EURx);

    expect(cached.rateScaled).toBe(direct.rateScaled);
  });

  it('discards an unreadable cache entry instead of failing', async () => {
    const redis = fakeRedis();
    redis.store.set('fx:usd-table:v1', 'not json');
    const live = provider('live', table('live'));
    const { service } = build([live], { redis });

    const result = await service.getTable();

    expect(result.source).toBe('live');
    expect(live.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips caching entirely when the TTL is zero', async () => {
    const live = provider('live', table('live'));
    const { service, redis } = build([live], { ttl: 0 });

    await service.getTable();
    await service.getTable();

    expect(redis.store.size).toBe(0);
    expect(live.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('FxService rate derivation', () => {
  it('derives a cross rate from two USD-based quotes', async () => {
    const { service } = build([provider('live', table('live'))]);

    // 1 USD = 1600 NGN and 1 USD = 16 GHS, so 1 cNGN = 0.01 cGHS.
    const resolved = await service.resolveRate(cNGN, cGHS);
    expect(MoneyUtil.rateToString(resolved.rateScaled)).toBe('0.01');
    expect(resolved.source).toBe('live');
    expect(resolved.asOf).toEqual(ASOF);
  });

  it('treats a same-currency conversion as pegged, without touching a provider', async () => {
    const live = provider('live', table('live'));
    const { service } = build([live]);

    const resolved = await service.resolveRate(cNGN, cNGN);

    expect(resolved.rateScaled).toBe(MoneyUtil.identityRate);
    expect(resolved.source).toBe('pegged');
    // This is what keeps same-currency transfers working during an FX outage.
    expect(live.fetch).not.toHaveBeenCalled();
  });

  it('quotes every ordered pair in the matrix, including identities', async () => {
    const { service } = build([provider('live', table('live'))]);

    const matrix = await service.getMatrix();

    expect(matrix.rates).toHaveLength(25);
    for (const entry of matrix.rates) {
      expect(BigInt(entry.rateScaled)).toBeGreaterThan(0n);
      if (entry.from === entry.to) expect(entry.rate).toBe('1');
    }
  });

  it('reports the degraded source on every pair when the provider is down', async () => {
    const { service } = build([failingProvider('live'), provider('static', table('fallback'))]);

    const matrix = await service.getMatrix();
    expect(matrix.source).toBe('fallback');
  });

  it('exposes USD rates for the wallet total', async () => {
    const { service } = build([provider('live', table('live'))]);

    const { rateTo } = await service.getUsdRates();

    expect(rateTo(USDx)).toBe(MoneyUtil.identityRate);
    // 1600 NGN per USD => 1 cNGN is 0.000625 USDx
    expect(MoneyUtil.rateToString(rateTo(cNGN))).toBe('0.000625');
  });

  it('raises RATE_UNAVAILABLE for a currency missing from the table', async () => {
    const partial: RateTable = { ...table('live'), perUsd: { USD: MoneyUtil.rateFromString('1') } };
    const { service } = build([provider('live', partial)]);

    // The table is usable for USD but quotes no NGN, so this one pair fails
    // while the rest of the system keeps working.
    await expect(service.resolveRate(cNGN, USDx)).rejects.toBeInstanceOf(AppError);
  });
});
