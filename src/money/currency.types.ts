/**
 * A currency code as clients send it, e.g. "cNGN".
 *
 * This is a plain string rather than a literal union because the set of
 * currencies lives in the database, so a new stablecoin is an INSERT rather
 * than a release. The cost is real and worth stating: the compiler can no longer
 * prove a switch over currencies is exhaustive, and an unknown code is caught at
 * runtime by CurrencyRegistry rather than at compile time.
 */
export type CurrencyCode = string;

/** A row of the `currencies` table. */
export interface CurrencyMeta {
  readonly code: CurrencyCode;
  /** ISO-4217 code of the fiat currency this stablecoin tracks 1:1. */
  readonly peg: string;
  /** Decimal places admitted; also the exponent between a major and minor unit. */
  readonly decimals: number;
  readonly name: string;
  readonly minorUnit: string;
  readonly isActive: boolean;
  /**
   * Fractional index controlling display order, as an exact decimal string.
   *
   * Carried as a string rather than Prisma's Decimal so no decimal object ever
   * reaches the rest of the app, and not as a number because that would
   * reintroduce the float imprecision the NUMERIC column exists to avoid.
   * Nothing in the application sorts by it - Postgres does, in the registry's
   * query - so a string is all that is needed.
   */
  readonly sortOrder: string;
}

/**
 * The minimum MoneyUtil needs to do arithmetic.
 *
 * Declaring it structurally keeps MoneyUtil free of any dependency on the
 * registry or the database, so it stays testable as pure arithmetic. `code` is
 * carried only so error messages can name the currency.
 */
export interface MoneyScale {
  readonly code: CurrencyCode;
  readonly decimals: number;
}

/** The currency every wallet total is expressed in, as the brief requires. */
export const USD_CURRENCY_CODE = 'USDx';
