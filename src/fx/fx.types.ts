import type { CurrencyCode } from '../money/currencies';

/** How a rate was obtained, in descending order of freshness. */
export type RateSourceName = 'live' | 'cached' | 'stale' | 'fallback' | 'pegged';

/**
 * A full set of rates quoted against USD: "how many units of X per 1 USD".
 *
 * Everything is derived from this one shape. Keeping a single USD-based table
 * rather than N^2 pairs means a provider fetch is one request, and every cross
 * rate is derived from two numbers that were refreshed at the same instant —
 * so a cNGN -> EURx rate can never be built from two rates hours apart.
 */
export interface RateTable {
  /** Peg code (NGN, GHS, XAF, USD, EUR) -> units per 1 USD, scaled by 1e12. */
  readonly perUsd: Readonly<Record<string, bigint>>;
  /** When the upstream provider last refreshed these numbers. */
  readonly asOf: Date;
  readonly source: RateSourceName;
}

/** A single resolved pair rate, as handed to the ledger. */
export interface ResolvedRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** Scaled by MoneyUtil.RATE_SCALE. */
  readonly rateScaled: bigint;
  readonly asOf: Date;
  readonly source: RateSourceName;
}

/**
 * The port every rate source implements.
 *
 * Three implementations are composed in order by FxService — live, snapshot,
 * static — so adding a provider means adding a class, not editing the service.
 * Tests inject fakes through this interface rather than mocking modules.
 */
export interface FxRateProvider {
  readonly name: string;
  /** Resolves to null when this provider cannot currently supply a table. */
  fetch(): Promise<RateTable | null>;
}

export const FX_RATE_PROVIDERS = Symbol('FX_RATE_PROVIDERS');
