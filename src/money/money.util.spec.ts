import { CURRENCY_CODES, type CurrencyCode, currencyPairs, scaleOf } from './currencies';
import { MoneyError } from './money.error';
import { MoneyUtil } from './money.util';

const R = MoneyUtil.RATE_SCALE;

/** Helper: build a scaled rate from a decimal string, for readability in tests. */
const rate = (s: string): bigint => MoneyUtil.parseRate(s);

describe('MoneyUtil.parse', () => {
  it('converts decimal strings to minor units at the currency scale', () => {
    expect(MoneyUtil.parse('1234.56', 'cNGN')).toBe(123456n);
    expect(MoneyUtil.parse('1234.5', 'cNGN')).toBe(123450n);
    expect(MoneyUtil.parse('1234', 'cNGN')).toBe(123400n);
    expect(MoneyUtil.parse('0.01', 'cNGN')).toBe(1n);
    expect(MoneyUtil.parse('1', 'USDx')).toBe(1_000_000n);
    expect(MoneyUtil.parse('0.000001', 'USDx')).toBe(1n);
    expect(MoneyUtil.parse('0', 'USDx')).toBe(0n);
  });

  it('treats cXAF as having no subunit', () => {
    expect(MoneyUtil.parse('1500', 'cXAF')).toBe(1500n);
    expect(() => MoneyUtil.parse('1500.5', 'cXAF')).toThrow(MoneyError);
    expect(() => MoneyUtil.parse('1500.0', 'cXAF')).toThrow(MoneyError);
  });

  it('rejects more precision than the currency admits rather than rounding', () => {
    // The whole point: silently turning 0.005 into 0.01 (or 0.00) would be a
    // money bug that no test downstream could detect.
    expect(() => MoneyUtil.parse('0.005', 'cNGN')).toThrow(
      expect.objectContaining({ code: 'AMOUNT_PRECISION_EXCEEDED' }),
    );
    expect(() => MoneyUtil.parse('1.0000001', 'USDx')).toThrow(
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
    expect(() => MoneyUtil.parse(input, 'cNGN')).toThrow(MoneyError);
  });

  it('rejects amounts beyond what BIGINT can store', () => {
    expect(() => MoneyUtil.parse('99999999999999999999', 'USDx')).toThrow(
      expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }),
    );
  });

  it('accepts the largest storable amount', () => {
    const max = MoneyUtil.format(MoneyUtil.MAX_INT64, 'USDx');
    expect(MoneyUtil.parse(max, 'USDx')).toBe(MoneyUtil.MAX_INT64);
  });
});

describe('MoneyUtil.format', () => {
  it('emits exactly the currency precision', () => {
    expect(MoneyUtil.format(123456n, 'cNGN')).toBe('1234.56');
    expect(MoneyUtil.format(1n, 'cNGN')).toBe('0.01');
    expect(MoneyUtil.format(0n, 'cNGN')).toBe('0.00');
    expect(MoneyUtil.format(1_000_000n, 'USDx')).toBe('1.000000');
    expect(MoneyUtil.format(1500n, 'cXAF')).toBe('1500');
    expect(MoneyUtil.format(0n, 'cXAF')).toBe('0');
  });

  it('renders the negative positions that clearing accounts hold', () => {
    expect(MoneyUtil.format(-123456n, 'cNGN')).toBe('-1234.56');
    expect(MoneyUtil.format(-1n, 'USDx')).toBe('-0.000001');
  });

  it('round-trips every currency', () => {
    for (const currency of CURRENCY_CODES) {
      for (const minor of [0n, 1n, 7n, 999n, 1_000_000n, 123_456_789n]) {
        expect(MoneyUtil.parse(MoneyUtil.format(minor, currency), currency)).toBe(minor);
      }
    }
  });
});

describe('MoneyUtil.parseRate / rateFromNumber', () => {
  it('scales a rate by 1e12', () => {
    expect(MoneyUtil.parseRate('1')).toBe(R);
    expect(MoneyUtil.parseRate('1612.45')).toBe(1_612_450_000_000_000n);
    expect(MoneyUtil.parseRate('0.5')).toBe(R / 2n);
  });

  it('rounds half-up at the 12th decimal instead of rejecting extra precision', () => {
    // A provider may publish any number of digits; that is not a client error.
    expect(MoneyUtil.parseRate('0.0000000000005')).toBe(1n);
    expect(MoneyUtil.parseRate('1.0000000000004')).toBe(R);
    expect(MoneyUtil.parseRate('1.0000000000005')).toBe(R + 1n);
  });

  it('rejects a rate that underflows the stored precision', () => {
    // 4e-13 rounds to zero at 1e-12, and a zero rate would silently convert
    // every amount to nothing. Refusing it is safer than storing it.
    expect(() => MoneyUtil.parseRate('0.0000000000004')).toThrow(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
  });

  it('rejects non-positive and malformed rates', () => {
    expect(() => MoneyUtil.parseRate('0')).toThrow(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
    expect(() => MoneyUtil.parseRate('-1')).toThrow(MoneyError);
    expect(() => MoneyUtil.parseRate('abc')).toThrow(MoneyError);
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
    expect(MoneyUtil.formatRate(R)).toBe('1');
    expect(MoneyUtil.formatRate(1_612_450_000_000_000n)).toBe('1612.45');
    expect(MoneyUtil.formatRate(R / 2n)).toBe('0.5');
  });
});

describe('MoneyUtil.crossRate', () => {
  it('derives A -> B from two USD-based quotes', () => {
    // 1 USD = 1600 NGN, 1 USD = 16 GHS  =>  1 NGN = 0.01 GHS
    const ngnPerUsd = rate('1600');
    const ghsPerUsd = rate('16');
    expect(MoneyUtil.crossRate(ngnPerUsd, ghsPerUsd)).toBe(rate('0.01'));
  });

  it('is self-inverse to within one scale unit', () => {
    const a = rate('1612.45');
    const b = rate('0.9213');
    const forward = MoneyUtil.crossRate(a, b);
    const back = MoneyUtil.crossRate(b, a);
    const product = (forward * back) / R;
    // Three roundings are involved (half-up in each crossRate, then a truncating
    // division here), so the round trip can drift by a few units of 1e-12 -
    // about 4e-12 relative. It must not drift more than that.
    const drift = product > R ? product - R : R - product;
    expect(drift).toBeLessThanOrEqual(4n);
  });

  it('returns the identity rate for a currency against itself', () => {
    const a = rate('1612.45');
    expect(MoneyUtil.crossRate(a, a)).toBe(R);
  });

  it('rejects non-positive inputs', () => {
    expect(() => MoneyUtil.crossRate(0n, R)).toThrow(MoneyError);
    expect(() => MoneyUtil.crossRate(R, -1n)).toThrow(MoneyError);
  });
});

describe('MoneyUtil.convert', () => {
  it('converts across differing scales exactly when it can', () => {
    // 1000.00 cNGN at 1 cNGN = 0.000625 USDx -> 0.625000 USDx
    const result = MoneyUtil.convert({
      amount: MoneyUtil.parse('1000.00', 'cNGN'),
      from: 'cNGN',
      to: 'USDx',
      rateScaled: rate('0.000625'),
    });
    expect(MoneyUtil.format(result.amount, 'USDx')).toBe('0.625000');
    expect(result.exact).toBe(true);
    expect(result.remainder).toBe(0n);
  });

  it('floors rather than rounding, so value is never created', () => {
    // 1 cNGN (0.01) at 0.0005 -> 0.000005 USDx exactly; add a rate that forces dust.
    const result = MoneyUtil.convert({
      amount: MoneyUtil.parse('0.01', 'cNGN'),
      from: 'cNGN',
      to: 'cXAF',
      rateScaled: rate('0.37'),
    });
    // 0.01 cNGN -> 0.0037 cXAF, and cXAF has no subunit, so the credit is 0.
    expect(result.amount).toBe(0n);
    expect(result.exact).toBe(false);
    expect(result.remainder).toBeGreaterThan(0n);
  });

  it('reports the discarded fraction as strictly less than one minor unit', () => {
    for (const [from, to] of currencyPairs()) {
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
    const amount = MoneyUtil.parse('1234.56', 'cNGN');
    const result = MoneyUtil.convert({
      amount,
      from: 'cNGN',
      to: 'cGHS',
      rateScaled: MoneyUtil.unitRate,
    });
    expect(result.amount).toBe(amount);
    expect(result.exact).toBe(true);
  });

  it('never returns more than the exact value', () => {
    // Property check: floor(x) <= x for a spread of amounts and rates.
    const rates = ['0.000001', '0.37', '1', '1.000001', '1612.45'];
    for (const [from, to] of currencyPairs()) {
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
          const exactNumerator = amount * rateScaled * 10n ** BigInt(scaleOf(to));
          expect(got * denominator + remainder).toBe(exactNumerator);
          expect(got * denominator).toBeLessThanOrEqual(exactNumerator);
        }
      }
    }
  });

  it('converts zero to zero', () => {
    const result = MoneyUtil.convert({
      amount: 0n,
      from: 'cNGN',
      to: 'USDx',
      rateScaled: rate('1612.45'),
    });
    expect(result.amount).toBe(0n);
    expect(result.exact).toBe(true);
  });

  it('rejects negative amounts and non-positive rates', () => {
    expect(() =>
      MoneyUtil.convert({ amount: -1n, from: 'cNGN', to: 'USDx', rateScaled: R }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    expect(() =>
      MoneyUtil.convert({ amount: 1n, from: 'cNGN', to: 'USDx', rateScaled: 0n }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_RATE' }));
  });

  it('refuses to produce an amount that cannot be stored', () => {
    expect(() =>
      MoneyUtil.convert({
        amount: MoneyUtil.MAX_INT64,
        from: 'cXAF',
        to: 'USDx',
        rateScaled: rate('1000'),
      }),
    ).toThrow(expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }));
  });
});

describe('MoneyUtil.sumAsUsd', () => {
  it('totals mixed balances into USDx', () => {
    const rates: Record<string, bigint> = {
      cNGN: rate('0.000625'), // 1600 NGN per USD
      cGHS: rate('0.0625'), // 16 GHS per USD
      cXAF: rate('0.0016'), // 625 XAF per USD
      EURx: rate('1.08'),
    };
    const total = MoneyUtil.sumAsUsd(
      [
        { currency: 'cNGN', amount: MoneyUtil.parse('1600.00', 'cNGN') },
        { currency: 'USDx', amount: MoneyUtil.parse('5.000000', 'USDx') },
        { currency: 'EURx', amount: MoneyUtil.parse('1.000000', 'EURx') },
      ],
      (from) => rates[from] as bigint,
      'USDx',
    );
    // 1.00 + 5.00 + 1.08
    expect(MoneyUtil.format(total, 'USDx')).toBe('7.080000');
  });

  it('skips zero balances without consulting a rate', () => {
    const total = MoneyUtil.sumAsUsd(
      [{ currency: 'cNGN', amount: 0n }],
      () => {
        throw new Error('should not need a rate for a zero balance');
      },
      'USDx',
    );
    expect(total).toBe(0n);
  });
});

describe('currency registry', () => {
  it('describes every currency', () => {
    for (const code of CURRENCY_CODES) {
      const described = MoneyUtil.describe(code);
      expect(described.code).toBe(code);
      expect(described.decimals).toBe(scaleOf(code));
      expect(described.smallestAmount).toBe(MoneyUtil.format(1n, code));
    }
  });

  it('enumerates every ordered pair exactly once', () => {
    const pairs = currencyPairs();
    const n = CURRENCY_CODES.length;
    expect(pairs).toHaveLength(n * (n - 1));
    expect(
      new Set(pairs.map(([a, b]: readonly [CurrencyCode, CurrencyCode]) => `${a}:${b}`)).size,
    ).toBe(pairs.length);
  });
});
