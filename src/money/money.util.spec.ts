import type { CurrencyMeta, MoneyScale } from './currency.types';
import { MoneyError } from './money.error';
import { MoneyUtil } from './money.util';

/**
 * Fixed scales, declared locally rather than read from the currency table.
 *
 * MoneyUtil is pure arithmetic over a scale, so its tests should not depend on
 * what happens to be configured in the database — these stay meaningful even if
 * the deployed currency set changes entirely.
 */
const cNGN = { code: 'cNGN', decimals: 2 } as const;
const cGHS = { code: 'cGHS', decimals: 2 } as const;
const cXAF = { code: 'cXAF', decimals: 0 } as const;
const USDx = { code: 'USDx', decimals: 6 } as const;
const EURx = { code: 'EURx', decimals: 6 } as const;

const ALL: readonly MoneyScale[] = [cNGN, cGHS, cXAF, USDx, EURx];

/** Every ordered pair of distinct scales. */
function pairs(): ReadonlyArray<readonly [MoneyScale, MoneyScale]> {
  const out: Array<readonly [MoneyScale, MoneyScale]> = [];
  for (const from of ALL) {
    for (const to of ALL) {
      if (from.code !== to.code) out.push([from, to]);
    }
  }
  return out;
}

const R = MoneyUtil.RATE_SCALE;

/** Helper: build a scaled rate from a decimal string, for readability in tests. */
const rate = (s: string): bigint => MoneyUtil.rateFromString(s);

describe('MoneyUtil.toMinorUnits', () => {
  it('converts decimal strings to minor units at the currency scale', () => {
    expect(MoneyUtil.toMinorUnits('1234.56', cNGN)).toBe(123456n);
    expect(MoneyUtil.toMinorUnits('1234.5', cNGN)).toBe(123450n);
    expect(MoneyUtil.toMinorUnits('1234', cNGN)).toBe(123400n);
    expect(MoneyUtil.toMinorUnits('0.01', cNGN)).toBe(1n);
    expect(MoneyUtil.toMinorUnits('1', USDx)).toBe(1_000_000n);
    expect(MoneyUtil.toMinorUnits('0.000001', USDx)).toBe(1n);
    expect(MoneyUtil.toMinorUnits('0', USDx)).toBe(0n);
  });

  it('treats cXAF as having no subunit', () => {
    expect(MoneyUtil.toMinorUnits('1500', cXAF)).toBe(1500n);
    expect(() => MoneyUtil.toMinorUnits('1500.5', cXAF)).toThrow(MoneyError);
    expect(() => MoneyUtil.toMinorUnits('1500.0', cXAF)).toThrow(MoneyError);
  });

  it('rejects more precision than the currency admits rather than rounding', () => {
    // The whole point: silently turning 0.005 into 0.01 (or 0.00) would be a
    // money bug that no test downstream could detect.
    expect(() => MoneyUtil.toMinorUnits('0.005', cNGN)).toThrow(
      expect.objectContaining({ code: 'AMOUNT_PRECISION_EXCEEDED' }),
    );
    expect(() => MoneyUtil.toMinorUnits('1.0000001', USDx)).toThrow(
      expect.objectContaining({ code: 'AMOUNT_PRECISION_EXCEEDED' }),
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['negative', '-1.00'],
    ['explicit positive', '+1.00'],
    ['exponent', '1e3'],
    ['thousands separator', '1,000.00'],
    ['trailing dot', '1.'],
    ['leading dot', '.5'],
    ['two dots', '1.2.3'],
    ['hex', '0x10'],
    ['not a number', 'abc'],
    ['infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['internal space', '1 00'],
  ])('rejects %s', (_label, input) => {
    expect(() => MoneyUtil.toMinorUnits(input, cNGN)).toThrow(MoneyError);
  });

  it('rejects amounts beyond what BIGINT can store', () => {
    expect(() => MoneyUtil.toMinorUnits('99999999999999999999', USDx)).toThrow(
      expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }),
    );
  });

  it('accepts the largest storable amount', () => {
    const max = MoneyUtil.toDecimalString(MoneyUtil.MAX_INT64, USDx);
    expect(MoneyUtil.toMinorUnits(max, USDx)).toBe(MoneyUtil.MAX_INT64);
  });
});

describe('MoneyUtil.toDecimalString', () => {
  it('emits exactly the currency precision', () => {
    expect(MoneyUtil.toDecimalString(123456n, cNGN)).toBe('1234.56');
    expect(MoneyUtil.toDecimalString(1n, cNGN)).toBe('0.01');
    expect(MoneyUtil.toDecimalString(0n, cNGN)).toBe('0.00');
    expect(MoneyUtil.toDecimalString(1_000_000n, USDx)).toBe('1.000000');
    expect(MoneyUtil.toDecimalString(1500n, cXAF)).toBe('1500');
    expect(MoneyUtil.toDecimalString(0n, cXAF)).toBe('0');
  });

  it('renders the negative positions that clearing accounts hold', () => {
    expect(MoneyUtil.toDecimalString(-123456n, cNGN)).toBe('-1234.56');
    expect(MoneyUtil.toDecimalString(-1n, USDx)).toBe('-0.000001');
  });

  it('round-trips every currency', () => {
    for (const currency of ALL) {
      for (const minor of [0n, 1n, 7n, 999n, 1_000_000n, 123_456_789n]) {
        expect(MoneyUtil.toMinorUnits(MoneyUtil.toDecimalString(minor, currency), currency)).toBe(
          minor,
        );
      }
    }
  });
});

describe('MoneyUtil.rateFromString / rateFromNumber', () => {
  it('scales a rate by 1e12', () => {
    expect(MoneyUtil.rateFromString('1')).toBe(R);
    expect(MoneyUtil.rateFromString('1612.45')).toBe(1_612_450_000_000_000n);
    expect(MoneyUtil.rateFromString('0.5')).toBe(R / 2n);
  });

  it('rounds half-up at the 12th decimal instead of rejecting extra precision', () => {
    // A provider may publish any number of digits; that is not a client error.
    expect(MoneyUtil.rateFromString('0.0000000000005')).toBe(1n);
    expect(MoneyUtil.rateFromString('1.0000000000004')).toBe(R);
    expect(MoneyUtil.rateFromString('1.0000000000005')).toBe(R + 1n);
  });

  it('rejects a rate that underflows the stored precision', () => {
    // 4e-13 rounds to zero at 1e-12, and a zero rate would silently convert
    // every amount to nothing. Refusing it is safer than storing it.
    expect(() => MoneyUtil.rateFromString('0.0000000000004')).toThrow(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
  });

  it('rejects non-positive and malformed rates', () => {
    expect(() => MoneyUtil.rateFromString('0')).toThrow(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
    expect(() => MoneyUtil.rateFromString('-1')).toThrow(MoneyError);
    expect(() => MoneyUtil.rateFromString('abc')).toThrow(MoneyError);
  });

  it('converts a provider float to an exact integer at the boundary', () => {
    expect(MoneyUtil.rateFromNumber(1612.45)).toBe(1_612_450_000_000_000n);
    expect(MoneyUtil.rateFromNumber(1)).toBe(R);
    // Exponential notation from JSON must not become "1e-7".
    expect(MoneyUtil.rateFromNumber(1e-7)).toBe(100_000n);
  });

  it('rejects a float that cannot be a rate', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => MoneyUtil.rateFromNumber(bad)).toThrow(MoneyError);
    }
  });

  it('formats rates without trailing noise', () => {
    expect(MoneyUtil.rateToString(R)).toBe('1');
    expect(MoneyUtil.rateToString(1_612_450_000_000_000n)).toBe('1612.45');
    expect(MoneyUtil.rateToString(R / 2n)).toBe('0.5');
  });
});

describe('MoneyUtil.crossRateViaUsd', () => {
  it('derives A -> B from two USD-based quotes', () => {
    // 1 USD = 1600 NGN, 1 USD = 16 GHS  =>  1 NGN = 0.01 GHS
    const ngnPerUsd = rate('1600');
    const ghsPerUsd = rate('16');
    expect(MoneyUtil.crossRateViaUsd(ngnPerUsd, ghsPerUsd)).toBe(rate('0.01'));
  });

  it('is self-inverse to within one scale unit', () => {
    const a = rate('1612.45');
    const b = rate('0.9213');
    const forward = MoneyUtil.crossRateViaUsd(a, b);
    const back = MoneyUtil.crossRateViaUsd(b, a);
    const product = (forward * back) / R;
    // Three roundings are involved (half-up in each crossRate, then a truncating
    // division here), so the round trip can drift by a few units of 1e-12 -
    // about 4e-12 relative. It must not drift more than that.
    const drift = product > R ? product - R : R - product;
    expect(drift).toBeLessThanOrEqual(4n);
  });

  it('returns the identity rate for a currency against itself', () => {
    const a = rate('1612.45');
    expect(MoneyUtil.crossRateViaUsd(a, a)).toBe(R);
  });

  it('rejects non-positive inputs', () => {
    expect(() => MoneyUtil.crossRateViaUsd(0n, R)).toThrow(MoneyError);
    expect(() => MoneyUtil.crossRateViaUsd(R, -1n)).toThrow(MoneyError);
  });
});

describe('MoneyUtil.convert', () => {
  it('converts across differing scales exactly when it can', () => {
    // 1000.00 cNGN at 1 cNGN = 0.000625 USDx -> 0.625000 USDx
    const result = MoneyUtil.convert({
      amount: MoneyUtil.toMinorUnits('1000.00', cNGN),
      from: cNGN,
      to: USDx,
      rateScaled: rate('0.000625'),
    });
    expect(MoneyUtil.toDecimalString(result.amount, USDx)).toBe('0.625000');
    expect(result.exact).toBe(true);
    expect(result.remainder).toBe(0n);
  });

  it('floors rather than rounding, so value is never created', () => {
    // 1 cNGN (0.01) at 0.0005 -> 0.000005 USDx exactly; add a rate that forces dust.
    const result = MoneyUtil.convert({
      amount: MoneyUtil.toMinorUnits('0.01', cNGN),
      from: cNGN,
      to: cXAF,
      rateScaled: rate('0.37'),
    });
    // 0.01 cNGN -> 0.0037 cXAF, and cXAF has no subunit, so the credit is 0.
    expect(result.amount).toBe(0n);
    expect(result.exact).toBe(false);
    expect(result.remainder).toBeGreaterThan(0n);
  });

  it('reports the discarded fraction as strictly less than one minor unit', () => {
    for (const [from, to] of pairs()) {
      for (const r of ['0.37', '1.5', '1612.45', '0.000625']) {
        const result = MoneyUtil.convert({
          amount: 12_345n,
          from,
          to,
          rateScaled: rate(r),
        });
        expect(result.remainder).toBeGreaterThanOrEqual(0n);
        expect(result.remainder).toBeLessThan(result.denominator);
      }
    }
  });

  it('is the identity at a rate of exactly 1 between equal scales', () => {
    const amount = MoneyUtil.toMinorUnits('1234.56', cNGN);
    const result = MoneyUtil.convert({
      amount,
      from: cNGN,
      to: cGHS,
      rateScaled: MoneyUtil.identityRate,
    });
    expect(result.amount).toBe(amount);
    expect(result.exact).toBe(true);
  });

  it('never returns more than the exact value', () => {
    // Property check: floor(x) <= x for a spread of amounts and rates.
    const rates = ['0.000001', '0.37', '1', '1.000001', '1612.45'];
    for (const [from, to] of pairs()) {
      for (const r of rates) {
        const rateScaled = rate(r);
        for (const amount of [1n, 7n, 999n, 100_000n, 98_765_432n]) {
          const {
            amount: got,
            remainder,
            denominator,
          } = MoneyUtil.convert({
            amount,
            from,
            to,
            rateScaled,
          });
          const exactNumerator = amount * rateScaled * 10n ** BigInt(to.decimals);
          expect(got * denominator + remainder).toBe(exactNumerator);
          expect(got * denominator).toBeLessThanOrEqual(exactNumerator);
        }
      }
    }
  });

  it('converts zero to zero', () => {
    const result = MoneyUtil.convert({
      amount: 0n,
      from: cNGN,
      to: USDx,
      rateScaled: rate('1612.45'),
    });
    expect(result.amount).toBe(0n);
    expect(result.exact).toBe(true);
  });

  it('rejects negative amounts and non-positive rates', () => {
    expect(() => MoneyUtil.convert({ amount: -1n, from: cNGN, to: USDx, rateScaled: R })).toThrow(
      expect.objectContaining({ code: 'INVALID_AMOUNT' }),
    );
    expect(() => MoneyUtil.convert({ amount: 1n, from: cNGN, to: USDx, rateScaled: 0n })).toThrow(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
  });

  it('refuses to produce an amount that cannot be stored', () => {
    expect(() =>
      MoneyUtil.convert({
        amount: MoneyUtil.MAX_INT64,
        from: cXAF,
        to: USDx,
        rateScaled: rate('1000'),
      }),
    ).toThrow(expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }));
  });
});

describe('MoneyUtil.totalInUsd', () => {
  it('totals mixed balances into USDx', () => {
    const rates: Record<string, bigint> = {
      cNGN: rate('0.000625'), // 1600 NGN per USD
      cGHS: rate('0.0625'), // 16 GHS per USD
      cXAF: rate('0.0016'), // 625 XAF per USD
      EURx: rate('1.08'),
    };
    const total = MoneyUtil.totalInUsd<MoneyScale>(
      [
        { currency: cNGN, amount: MoneyUtil.toMinorUnits('1600.00', cNGN) },
        { currency: USDx, amount: MoneyUtil.toMinorUnits('5.000000', USDx) },
        { currency: EURx, amount: MoneyUtil.toMinorUnits('1.000000', EURx) },
      ],
      (from) => rates[from.code] as bigint,
      USDx,
    );
    // 1.00 + 5.00 + 1.08
    expect(MoneyUtil.toDecimalString(total, USDx)).toBe('7.080000');
  });

  it('skips zero balances without consulting a rate', () => {
    const total = MoneyUtil.totalInUsd<MoneyScale>(
      [{ currency: cNGN, amount: 0n }],
      () => {
        throw new Error('should not need a rate for a zero balance');
      },
      USDx,
    );
    expect(total).toBe(0n);
  });
});

describe('MoneyUtil.describeCurrency', () => {
  it('renders a currency row for GET /currencies', () => {
    const meta: CurrencyMeta = {
      code: 'cXAF',
      peg: 'XAF',
      decimals: 0,
      name: 'Central African CFA franc stablecoin',
      minorUnit: 'franc',
      isActive: true,
      sortOrder: '0.3',
    };

    expect(MoneyUtil.describeCurrency(meta)).toEqual({
      code: 'cXAF',
      name: 'Central African CFA franc stablecoin',
      peg: 'XAF',
      decimals: 0,
      minorUnit: 'franc',
      // A zero-decimal currency's smallest amount is 1, not 0.01.
      smallestAmount: '1',
    });
  });

  it('reflects whatever precision the table declares', () => {
    const exotic: CurrencyMeta = {
      code: 'cTEST',
      peg: 'TST',
      decimals: 8,
      name: 'Test coin',
      minorUnit: 'satoshi-ish',
      isActive: true,
      sortOrder: '0.9',
    };

    // Precision is data, so MoneyUtil must handle a scale it has never seen.
    expect(MoneyUtil.describeCurrency(exotic).smallestAmount).toBe('0.00000001');
    expect(MoneyUtil.toMinorUnits('1.00000001', exotic)).toBe(100_000_001n);
  });
});
