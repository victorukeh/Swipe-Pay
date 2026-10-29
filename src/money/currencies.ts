/**
 * The supported mock stablecoins.
 *
 * Each is pegged 1:1 to a real fiat currency, which is what makes FX meaningful:
 * a cNGN -> USDx swap is really an NGN -> USD conversion. `scale` is the number
 * of decimal places the currency admits, and therefore the exponent that turns a
 * human amount into the integer minor-unit value we store.
 *
 * Note cXAF has a scale of 0. The Central African CFA franc genuinely has no
 * subunit in circulation, so "100.50 cXAF" is not a representable amount and is
 * rejected rather than silently rounded.
 */
export const CURRENCIES = {
  cNGN: { peg: 'NGN', scale: 2, name: 'Nigerian Naira stablecoin', minorUnit: 'kobo' },
  cGHS: { peg: 'GHS', scale: 2, name: 'Ghanaian Cedi stablecoin', minorUnit: 'pesewa' },
  cXAF: { peg: 'XAF', scale: 0, name: 'Central African CFA franc stablecoin', minorUnit: 'franc' },
  USDx: { peg: 'USD', scale: 6, name: 'US Dollar stablecoin', minorUnit: 'micro-dollar' },
  EURx: { peg: 'EUR', scale: 6, name: 'Euro stablecoin', minorUnit: 'micro-euro' },
} as const satisfies Record<string, CurrencyMeta>;

export interface CurrencyMeta {
  /** ISO-4217 code of the fiat currency this stablecoin tracks 1:1. */
  readonly peg: string;
  /** Decimal places; also the power of ten between a major unit and a minor unit. */
  readonly scale: number;
  readonly name: string;
  readonly minorUnit: string;
}

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as readonly CurrencyCode[];

/** The currency every wallet total is expressed in, as the brief requires. */
export const USD_CURRENCY: CurrencyCode = 'USDx';

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function currencyMeta(code: CurrencyCode): CurrencyMeta {
  return CURRENCIES[code];
}

export function scaleOf(code: CurrencyCode): number {
  return CURRENCIES[code].scale;
}

export function pegOf(code: CurrencyCode): string {
  return CURRENCIES[code].peg;
}

/** Peg -> stablecoin, used when mapping an upstream FX response onto our codes. */
export const PEG_TO_CURRENCY: Readonly<Record<string, CurrencyCode>> = Object.freeze(
  Object.fromEntries(CURRENCY_CODES.map((code) => [CURRENCIES[code].peg, code])),
);

/** Every ordered pair of distinct currencies — the shape of the GET /rates matrix. */
export function currencyPairs(): ReadonlyArray<readonly [CurrencyCode, CurrencyCode]> {
  const pairs: Array<readonly [CurrencyCode, CurrencyCode]> = [];
  for (const base of CURRENCY_CODES) {
    for (const quote of CURRENCY_CODES) {
      if (base !== quote) pairs.push([base, quote]);
    }
  }
  return pairs;
}
