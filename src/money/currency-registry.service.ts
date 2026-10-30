import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { AppError } from '../common/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import type { CurrencyCode, CurrencyMeta } from './currency.types';
import { USD_CURRENCY_CODE } from './currency.types';

/**
 * The `currencies` table, read once at boot and held in memory -- cached
 * because every deposit, swap and transfer needs a currency's precision,
 * and that must not become a DB round trip inside a transaction already
 * holding row locks. An unknown code is a runtime 422
 * (`require()` is the chokepoint); a currency added while the process is
 * running isn't visible until `refresh()`.
 */
@Injectable()
export class CurrencyRegistry implements OnModuleInit {
  private readonly logger = new Logger(CurrencyRegistry.name);

  private byCode = new Map<CurrencyCode, CurrencyMeta>();
  private byPeg = new Map<string, CurrencyMeta>();
  private ordered: readonly CurrencyMeta[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Reloads from the database. Called at boot and available to operations. */
  async refresh(): Promise<void> {
    const rows = await this.prisma.currency.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });

    const byCode = new Map<CurrencyCode, CurrencyMeta>();
    const byPeg = new Map<string, CurrencyMeta>();

    for (const row of rows) {
      const meta: CurrencyMeta = {
        code: row.code,
        peg: row.peg,
        decimals: row.decimals,
        name: row.name,
        minorUnit: row.minorUnit,
        isActive: row.isActive,
        sortOrder: row.sortOrder.toString(),
      };
      byCode.set(meta.code, meta);
      // Two stablecoins pegged to the same fiat would make a cross rate
      // ambiguous, so the first by sort order wins and the clash is logged.
      if (byPeg.has(meta.peg)) {
        this.logger.warn(
          `Currencies ${byPeg.get(meta.peg)?.code} and ${meta.code} share the peg ${meta.peg}; using the former for rate lookups`,
        );
      } else {
        byPeg.set(meta.peg, meta);
      }
    }

    // An active USDx implies a non-empty, usable table, and keeps `usd()`
    // non-throwing. Logged (not returned to a client) since it names our
    // schema and tooling; AppError.internal still aborts startup here.
    const usd = byCode.get(USD_CURRENCY_CODE);
    if (!usd?.isActive) {
      const detail = `The currencies table must contain an active ${USD_CURRENCY_CODE}; wallet totals are denominated in it. Run \`yarn db:seed\` to load prisma/seeds/currencies.json.`;
      this.logger.error(detail);
      throw AppError.internal(new Error(detail));
    }

    this.byCode = byCode;
    this.byPeg = byPeg;
    this.ordered = rows
      .filter((row) => row.isActive)
      .map((row) => byCode.get(row.code))
      .filter((meta): meta is CurrencyMeta => meta !== undefined);

    this.logger.log(
      `Loaded ${this.ordered.length} active currencies: ${this.ordered.map((c) => c.code).join(', ')}`,
    );
  }

  /** Active currencies, in display order. */
  all(): readonly CurrencyMeta[] {
    return this.ordered;
  }

  /** Active currency codes, in display order. */
  codes(): readonly CurrencyCode[] {
    return this.ordered.map((meta) => meta.code);
  }

  /** Looks up a currency, including inactive ones, so history stays readable. */
  find(code: CurrencyCode): CurrencyMeta | undefined {
    return this.byCode.get(code);
  }

  /**
   * The single chokepoint for validating a client-supplied currency.
   *
   * Rejects an unknown code, and also rejects a deactivated one — history
   * involving it stays readable through `find()`, but no new money may move in it.
   */
  require(code: unknown): CurrencyMeta {
    if (typeof code !== 'string') throw AppError.unsupportedCurrency(code);

    const meta = this.byCode.get(code);
    if (!meta || !meta.isActive) throw AppError.unsupportedCurrency(code);
    return meta;
  }

  /** The currency wallet totals are quoted in. */
  usd(): CurrencyMeta {
    return this.require(USD_CURRENCY_CODE);
  }

  /** Resolve by fiat peg, used when mapping an upstream FX response onto our codes. */
  findByPeg(peg: string): CurrencyMeta | undefined {
    return this.byPeg.get(peg);
  }

  /** Every ordered pair of active currencies, including identities. */
  pairs(): ReadonlyArray<readonly [CurrencyMeta, CurrencyMeta]> {
    const pairs: Array<readonly [CurrencyMeta, CurrencyMeta]> = [];
    for (const from of this.ordered) {
      for (const to of this.ordered) {
        pairs.push([from, to]);
      }
    }
    return pairs;
  }
}
