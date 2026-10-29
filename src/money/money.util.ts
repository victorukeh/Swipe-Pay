import type { CurrencyMeta, MoneyScale } from './currency.types';
import { MoneyError } from './money.error';
import type { ConversionResult } from './money.types';

/**
 * All money arithmetic in Cardtonic. Nothing else is allowed to do it.
 *
 * ## Why integers
 *
 * An amount is a `bigint` count of a currency's minor units — kobo for cNGN,
 * micro-dollars for USDx, whole francs for cXAF. There is no `number` and no
 * `Decimal` on any path that touches money, because IEEE-754 cannot represent
 * 0.1 and a decimal library still leaves the rounding policy implicit. Integers
 * make the policy explicit and the arithmetic exact.
 *
 * Amounts cross the API boundary as decimal *strings* for the same reason:
 * `JSON.parse('{"amount": 0.1}')` already has a float in it before any of our
 * code runs.
 *
 * ## Why rates are integers too
 *
 * A rate is stored scaled by `RATE_SCALE` (1e12), so "1 USD = 1612.45 NGN" is
 * the integer 1_612_450_000_000_000. Conversion is then a single exact
 * expression over integers with one explicitly chosen rounding step, rather than
 * a chain of floating-point multiplications.
 *
 * ## Rounding policy
 *
 * Conversions **floor** to the destination currency's precision. The discarded
 * part is always strictly less than one minor unit, and flooring guarantees the
 * system can never credit more value than it debited — it cannot mint money. The
 * dust accrues to the SYSTEM_FX clearing account, where it is auditable, rather
 * than vanishing.
 */
export class MoneyUtil {
  /** Decimal places of precision kept in a stored FX rate. */
  static readonly RATE_SCALE_EXPONENT = 12;

  /** 1e12, as an integer. A `rateScaled` of RATE_SCALE means a rate of exactly 1. */
  static readonly RATE_SCALE = 10n ** BigInt(MoneyUtil.RATE_SCALE_EXPONENT);

  /** Postgres BIGINT bound. Amounts are checked against it before they are stored. */
  static readonly MAX_INT64 = 2n ** 63n - 1n;

  /** Guards against pathological input before any parsing work happens. */
  private static readonly MAX_INPUT_LENGTH = 40;

  private static readonly DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

  // ---------------------------------------------------------------------------
  // Parsing and formatting
  // ---------------------------------------------------------------------------

  /**
   * Turn a client-supplied decimal string into minor units.
   *
   * Rejects anything that isn't an unsigned decimal literal — no exponents, no
   * signs, no whitespace, no thousands separators — and rejects more fraction
   * digits than the currency admits rather than rounding silently. "100.50 cXAF"
   * is not a representable amount (the CFA franc has no subunit), so it is an
   * error, not 100 or 101.
   */
  static toMinorUnits(input: string, currency: MoneyScale): bigint {
    if (typeof input !== 'string') {
      throw new MoneyError('INVALID_AMOUNT', 'Amount must be a decimal string', { input });
    }
    const raw = input.trim();

    if (raw.length === 0 || raw.length > MoneyUtil.MAX_INPUT_LENGTH) {
      throw new MoneyError('INVALID_AMOUNT', 'Amount must be a non-empty decimal string', {
        input,
      });
    }
    if (!MoneyUtil.DECIMAL_PATTERN.test(raw)) {
      throw new MoneyError(
        'INVALID_AMOUNT',
        'Amount must be an unsigned decimal string such as "1234.56" — no signs, exponents or separators',
        { input },
      );
    }

    const scale = currency.decimals;
    const [whole = '0', fraction = ''] = raw.split('.');

    if (fraction.length > scale) {
      throw new MoneyError(
        'AMOUNT_PRECISION_EXCEEDED',
        scale === 0
          ? `${currency.code} has no subunit, so the amount must be a whole number`
          : `${currency.code} supports at most ${scale} decimal place(s)`,
        { input, currency: currency.code, maxDecimals: scale, provided: fraction.length },
      );
    }

    const minor = BigInt(whole + fraction.padEnd(scale, '0'));

    if (minor > MoneyUtil.MAX_INT64) {
      throw new MoneyError('AMOUNT_OUT_OF_RANGE', 'Amount exceeds the supported range', {
        input,
        currency: currency.code,
      });
    }
    return minor;
  }

  /**
   * Render minor units as a fixed-precision decimal string.
   *
   * Always emits exactly the currency's number of decimal places, so "1 USDx"
   * reads as "1.000000". A fixed width removes any ambiguity about what
   * precision the value is being asserted at.
   */
  static toDecimalString(minor: bigint, currency: MoneyScale): string {
    const scale = currency.decimals;
    const negative = minor < 0n;
    const magnitude = negative ? -minor : minor;

    if (scale === 0) {
      return `${negative ? '-' : ''}${magnitude.toString()}`;
    }

    const divisor = 10n ** BigInt(scale);
    const whole = magnitude / divisor;
    const fraction = (magnitude % divisor).toString().padStart(scale, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
  }

  // ---------------------------------------------------------------------------
  // Rates
  // ---------------------------------------------------------------------------

  /**
   * Parse a rate into RATE_SCALE units, rounding half-up at the 12th decimal.
   *
   * Unlike an amount, extra precision in a rate is not a client error — upstream
   * providers publish however many digits they like — so it is rounded rather
   * than rejected.
   */
  static rateFromString(input: string): bigint {
    const raw = input.trim();
    if (!MoneyUtil.DECIMAL_PATTERN.test(raw)) {
      throw new MoneyError('INVALID_RATE', 'Rate must be an unsigned decimal string', { input });
    }

    const [whole = '0', fraction = ''] = raw.split('.');
    const exponent = MoneyUtil.RATE_SCALE_EXPONENT;

    const kept = fraction.slice(0, exponent).padEnd(exponent, '0');
    let scaled = BigInt(whole + kept);

    // Half-up on the first discarded digit.
    const nextDigit = fraction.charAt(exponent);
    if (nextDigit !== '' && Number(nextDigit) >= 5) {
      scaled += 1n;
    }

    if (scaled <= 0n) {
      throw new MoneyError('INVALID_RATE', 'Rate must be greater than zero', { input });
    }
    return scaled;
  }

  /**
   * Convert a provider-supplied JSON number into an exact scaled integer.
   *
   * This is the single point in the system where a floating-point value is
   * admitted, and it is converted immediately. `toFixed` is used rather than
   * `String()` so that values the provider sends in exponential form ("1e-7")
   * still land as plain decimals.
   */
  static rateFromNumber(value: number): bigint {
    if (!Number.isFinite(value) || value <= 0) {
      throw new MoneyError('INVALID_RATE', 'Rate must be a finite positive number', { value });
    }
    return MoneyUtil.rateFromString(value.toFixed(MoneyUtil.RATE_SCALE_EXPONENT));
  }

  /** Render a stored rate for display, trimming trailing zeros for readability. */
  static rateToString(rateScaled: bigint): string {
    const divisor = MoneyUtil.RATE_SCALE;
    const whole = rateScaled / divisor;
    const fraction = (rateScaled % divisor)
      .toString()
      .padStart(MoneyUtil.RATE_SCALE_EXPONENT, '0')
      .replace(/0+$/, '');
    return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
  }

  /**
   * Derive the A -> B rate from two rates quoted against a common base.
   *
   * Upstream publishes "units of X per 1 USD", so the cross rate is
   * perUsd[B] / perUsd[A]. Computed as one integer division on values already
   * scaled by RATE_SCALE, which keeps the full precision of both inputs rather
   * than compounding two roundings.
   */
  static crossRateViaUsd(perUsdFromScaled: bigint, perUsdToScaled: bigint): bigint {
    if (perUsdFromScaled <= 0n || perUsdToScaled <= 0n) {
      throw new MoneyError('INVALID_RATE', 'Rates must be greater than zero', {
        perUsdFromScaled: perUsdFromScaled.toString(),
        perUsdToScaled: perUsdToScaled.toString(),
      });
    }
    return MoneyUtil.divideHalfUp(perUsdToScaled * MoneyUtil.RATE_SCALE, perUsdFromScaled);
  }

  // ---------------------------------------------------------------------------
  // Conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert an amount between currencies at a given scaled rate.
   *
   * The whole calculation is one exact rational, evaluated with a single
   * explicit floor at the end:
   *
   *   numerator   = amount x rateScaled x 10^destScale
   *   denominator = RATE_SCALE x 10^sourceScale
   *   result      = floor(numerator / denominator)
   *
   * `remainder` is the discarded part expressed over `denominator`, so
   * `remainder / denominator` is the fraction of one destination minor unit that
   * was dropped — always strictly less than 1. It is returned rather than hidden
   * so callers can record it.
   */
  static convert(params: {
    amount: bigint;
    from: MoneyScale;
    to: MoneyScale;
    rateScaled: bigint;
  }): ConversionResult {
    const { amount, from, to, rateScaled } = params;

    if (amount < 0n) {
      throw new MoneyError('INVALID_AMOUNT', 'Cannot convert a negative amount', {
        amount: amount.toString(),
      });
    }
    if (rateScaled <= 0n) {
      throw new MoneyError('INVALID_RATE', 'Rate must be greater than zero', {
        rateScaled: rateScaled.toString(),
      });
    }

    const numerator = amount * rateScaled * 10n ** BigInt(to.decimals);
    const denominator = MoneyUtil.RATE_SCALE * 10n ** BigInt(from.decimals);

    const converted = numerator / denominator;
    const remainder = numerator % denominator;

    if (converted > MoneyUtil.MAX_INT64) {
      throw new MoneyError('AMOUNT_OUT_OF_RANGE', 'Converted amount exceeds the supported range', {
        from: from.code,
        to: to.code,
      });
    }

    return { amount: converted, remainder, denominator, exact: remainder === 0n };
  }

  /**
   * Total a set of balances in USDx.
   *
   * Each leg is floored independently, which is the conservative direction: a
   * reported total is never higher than the true one.
   */
  static totalInUsd<T extends MoneyScale>(
    balances: ReadonlyArray<{ currency: T; amount: bigint }>,
    rateTo: (from: T) => bigint,
    usdCurrency: MoneyScale,
  ): bigint {
    let total = 0n;
    for (const { currency, amount } of balances) {
      if (amount === 0n) continue;
      total +=
        currency.code === usdCurrency.code
          ? amount
          : MoneyUtil.convert({
              amount,
              from: currency,
              to: usdCurrency,
              rateScaled: rateTo(currency),
            }).amount;
    }
    return total;
  }

  /** Integer division rounding half away from zero. Inputs here are non-negative. */
  private static divideHalfUp(numerator: bigint, denominator: bigint): bigint {
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    return remainder * 2n >= denominator ? quotient + 1n : quotient;
  }

  /** The identity rate, for same-currency "conversions". */
  static get identityRate(): bigint {
    return MoneyUtil.RATE_SCALE;
  }

  /** Smallest representable positive amount in a currency, as a decimal string. */
  static smallestAmountOf(currency: MoneyScale): string {
    return MoneyUtil.toDecimalString(1n, currency);
  }

  /** Human description of a currency, for GET /currencies. */
  static describeCurrency(meta: CurrencyMeta) {
    return {
      code: meta.code,
      name: meta.name,
      peg: meta.peg,
      decimals: meta.decimals,
      minorUnit: meta.minorUnit,
      smallestAmount: MoneyUtil.smallestAmountOf(meta),
    };
  }
}
