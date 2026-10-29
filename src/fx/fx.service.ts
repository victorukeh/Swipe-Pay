import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError } from '../common/errors/app-error';
import type { EnvSchema } from '../config/env.schema';
import { CURRENCY_CODES, type CurrencyCode, pegOf } from '../money/currencies';
import { MoneyUtil } from '../money/money.util';
import { RedisService } from '../redis/redis.service';
import {
  FX_RATE_PROVIDERS,
  type FxRateProvider,
  type RateSourceName,
  type RateTable,
  type ResolvedRate,
} from './fx.types';
import { SnapshotFxProvider } from './providers/snapshot-fx.provider';

const CACHE_KEY = 'fx:usd-table:v1';

interface CachedTable {
  perUsd: Record<string, string>;
  asOf: string;
  source: RateSourceName;
}

/**
 * Resolves FX rates through a chain of providers, degrading rather than failing.
 *
 *   Redis cache -> live provider -> Postgres last-known-good -> static table
 *
 * The providers are injected as an ordered array behind the FxRateProvider
 * interface, so the service never names a concrete provider and a new source is
 * added by registering a class. The only concrete dependency is
 * SnapshotFxProvider, and only to *write* to it after a successful live fetch.
 *
 * Every result carries `source` and `asOf`, which are recorded on the
 * transaction and returned by GET /rates. A caller is always able to tell
 * whether their conversion used a live rate or a degraded one.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private readonly cacheTtlSeconds: number;

  constructor(
    @Inject(FX_RATE_PROVIDERS) private readonly providers: readonly FxRateProvider[],
    private readonly snapshots: SnapshotFxProvider,
    private readonly redis: RedisService,
    config: ConfigService<EnvSchema, true>,
  ) {
    this.cacheTtlSeconds = config.get('FX_CACHE_TTL_SECONDS', { infer: true });
  }

  /**
   * The current USD-based table.
   *
   * A cache hit is reported as `cached` rather than `live`, because "this number
   * came from a fetch up to five minutes ago" is materially different from "this
   * number was just fetched" and the caller deserves to know which.
   */
  async getTable(): Promise<RateTable> {
    const cached = await this.readCache();
    if (cached) return cached;

    for (const provider of this.providers) {
      const table = await provider.fetch();
      if (!table) continue;

      if (table.source === 'live') {
        // Persist before caching: the durable copy is the one that has to
        // survive a restart.
        await this.snapshots.persist(table);
      }
      await this.writeCache(table);
      return table;
    }

    // Only reachable if the static provider itself is removed or throws.
    throw AppError.rateUnavailable({ reason: 'every rate provider failed' });
  }

  /** The rate to apply when converting `from` into `to`. */
  async resolveRate(from: CurrencyCode, to: CurrencyCode): Promise<ResolvedRate> {
    if (from === to) {
      // A stablecoin is pegged 1:1 to itself; no provider involvement, and no
      // reason for a same-currency transfer to fail when FX is down.
      return { from, to, rateScaled: MoneyUtil.unitRate, asOf: new Date(), source: 'pegged' };
    }

    const table = await this.getTable();
    return {
      from,
      to,
      rateScaled: FxService.crossFromTable(table, from, to),
      asOf: table.asOf,
      source: table.source,
    };
  }

  /** Every ordered pair, for GET /rates. */
  async getMatrix(): Promise<{
    asOf: Date;
    source: RateSourceName;
    rates: Array<{ from: CurrencyCode; to: CurrencyCode; rate: string; rateScaled: bigint }>;
  }> {
    const table = await this.getTable();
    const rates: Array<{ from: CurrencyCode; to: CurrencyCode; rate: string; rateScaled: bigint }> =
      [];

    for (const from of CURRENCY_CODES) {
      for (const to of CURRENCY_CODES) {
        const rateScaled =
          from === to ? MoneyUtil.unitRate : FxService.crossFromTable(table, from, to);
        rates.push({ from, to, rate: MoneyUtil.formatRate(rateScaled), rateScaled });
      }
    }

    return { asOf: table.asOf, source: table.source, rates };
  }

  /** Rates for converting every currency into USDx, for the wallet total. */
  async getUsdRates(): Promise<{
    asOf: Date;
    source: RateSourceName;
    rateTo: (from: CurrencyCode) => bigint;
  }> {
    const table = await this.getTable();
    return {
      asOf: table.asOf,
      source: table.source,
      rateTo: (from) =>
        from === 'USDx' ? MoneyUtil.unitRate : FxService.crossFromTable(table, from, 'USDx'),
    };
  }

  /**
   * Derive a pair rate from the USD table.
   *
   * Both legs come from the same refresh, which is the point of storing a single
   * USD-based table: a cNGN -> EURx rate can never be assembled from two
   * quotes taken hours apart.
   */
  private static crossFromTable(table: RateTable, from: CurrencyCode, to: CurrencyCode): bigint {
    const fromPeg = pegOf(from);
    const toPeg = pegOf(to);
    const perUsdFrom = table.perUsd[fromPeg];
    const perUsdTo = table.perUsd[toPeg];

    if (perUsdFrom === undefined || perUsdTo === undefined) {
      throw AppError.rateUnavailable({ from, to });
    }
    return MoneyUtil.crossRate(perUsdFrom, perUsdTo);
  }

  private async readCache(): Promise<RateTable | null> {
    const raw = await this.redis.get(CACHE_KEY);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as CachedTable;
      const perUsd: Record<string, bigint> = {};
      for (const [peg, value] of Object.entries(parsed.perUsd)) {
        perUsd[peg] = BigInt(value);
      }
      return {
        perUsd,
        asOf: new Date(parsed.asOf),
        // A cached live rate is no longer live; say so.
        source: parsed.source === 'live' ? 'cached' : parsed.source,
      };
    } catch (error) {
      this.logger.warn(`Discarding unreadable FX cache entry: ${(error as Error).message}`);
      await this.redis.del(CACHE_KEY);
      return null;
    }
  }

  private async writeCache(table: RateTable): Promise<void> {
    if (this.cacheTtlSeconds <= 0) return;

    const payload: CachedTable = {
      // BigInt has no JSON representation, so rates are cached as strings
      // rather than being coerced through Number.
      perUsd: Object.fromEntries(
        Object.entries(table.perUsd).map(([peg, value]) => [peg, value.toString()]),
      ),
      asOf: table.asOf.toISOString(),
      source: table.source,
    };
    await this.redis.setEx(CACHE_KEY, this.cacheTtlSeconds, JSON.stringify(payload));
  }
}
