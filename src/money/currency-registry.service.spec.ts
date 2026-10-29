import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-code';
import type { PrismaService } from '../prisma/prisma.service';
import { CurrencyRegistry } from './currency-registry.service';

/** A Prisma row as the registry receives it: sortOrder arrives as a Decimal. */
function row(
  code: string,
  peg: string,
  decimals: number,
  sortOrder: string,
  isActive = true,
): Record<string, unknown> {
  return {
    code,
    peg,
    decimals,
    name: `${code} stablecoin`,
    minorUnit: 'unit',
    isActive,
    // Prisma hands back a Decimal; the registry must stringify rather than
    // coerce through Number, so the stub mimics the object shape.
    sortOrder: { toString: () => sortOrder },
  };
}

function prismaWith(rows: Array<Record<string, unknown>>): PrismaService {
  return {
    currency: { findMany: jest.fn().mockResolvedValue(rows) },
  } as unknown as PrismaService;
}

const DEFAULT_ROWS = [
  row('cNGN', 'NGN', 2, '0.1'),
  row('cGHS', 'GHS', 2, '0.2'),
  row('cXAF', 'XAF', 0, '0.3'),
  row('USDx', 'USD', 6, '0.4'),
  row('EURx', 'EUR', 6, '0.5'),
];

async function loaded(rows = DEFAULT_ROWS): Promise<CurrencyRegistry> {
  const registry = new CurrencyRegistry(prismaWith(rows));
  await registry.onModuleInit();
  return registry;
}

describe('CurrencyRegistry loading', () => {
  it('loads the table and reports codes in sort order', async () => {
    const registry = await loaded();
    expect(registry.codes()).toEqual(['cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx']);
  });

  it('carries precision straight from the table, including zero-decimal currencies', async () => {
    const registry = await loaded();
    expect(registry.require('cNGN').decimals).toBe(2);
    expect(registry.require('cXAF').decimals).toBe(0);
    expect(registry.require('USDx').decimals).toBe(6);
  });

  it('keeps the fractional index as an exact string, never a number', async () => {
    const registry = await loaded();
    const sortOrder = registry.require('cNGN').sortOrder;

    expect(typeof sortOrder).toBe('string');
    // Coercing through Number is exactly what the NUMERIC column exists to avoid.
    expect(sortOrder).toBe('0.1');
  });

  /**
   * One guard covers every way the table can be unusable, because an active
   * USDx implies both a non-empty table and a currency wallet totals can be
   * denominated in. Failing to boot is the useful behaviour: an API with no
   * usable currency can only emit confusing 422s on every request.
   */
  it.each([
    ['the table is empty', []],
    ['USDx is absent', [row('cNGN', 'NGN', 2, '0.1')]],
    ['USDx is deactivated', [row('cNGN', 'NGN', 2, '0.1'), row('USDx', 'USD', 6, '0.4', false)]],
  ])('refuses to start when %s', async (_label, rows) => {
    const registry = new CurrencyRegistry(prismaWith(rows));

    await expect(registry.onModuleInit()).rejects.toThrow(
      expect.objectContaining({ code: ErrorCode.INTERNAL_ERROR }),
    );
  });

  it('keeps the remediation in the cause rather than the client-facing message', async () => {
    const registry = new CurrencyRegistry(prismaWith([]));

    const error = await registry.onModuleInit().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);
    // A client can do nothing with "run yarn db:seed", and it names our schema
    // and tooling, so it travels on the cause and into the log - never into the
    // response envelope.
    expect((error as AppError).message).toBe('An unexpected error occurred');
    expect(((error as AppError).cause as Error).message).toMatch(/yarn db:seed/);
  });

  it('picks up a currency added to the table after boot, on refresh', async () => {
    const rows = [...DEFAULT_ROWS];
    const prisma = {
      currency: { findMany: jest.fn().mockImplementation(() => Promise.resolve([...rows])) },
    } as unknown as PrismaService;

    const registry = new CurrencyRegistry(prisma);
    await registry.onModuleInit();
    expect(registry.find('cKES')).toBeUndefined();

    // This is the payoff of the table being the authority: an INSERT, no release.
    rows.splice(2, 0, row('cKES', 'KES', 2, '0.25'));
    await registry.refresh();

    expect(registry.require('cKES').decimals).toBe(2);
    expect(registry.codes()).toEqual(['cNGN', 'cGHS', 'cKES', 'cXAF', 'USDx', 'EURx']);
  });
});

describe('CurrencyRegistry.require', () => {
  it('rejects an unknown code as UNSUPPORTED_CURRENCY', async () => {
    const registry = await loaded();

    // The cost of a database-driven currency set: this is a runtime rejection,
    // not a compile error. require() is the single place that check happens.
    expect(() => registry.require('cFAKE')).toThrow(
      expect.objectContaining({ code: ErrorCode.UNSUPPORTED_CURRENCY }),
    );
    expect(() => registry.require('cFAKE')).toThrow(AppError);
  });

  it.each([[null], [undefined], [42], [{}], [['cNGN']]])(
    'rejects the non-string input %p',
    async (input) => {
      const registry = await loaded();
      expect(() => registry.require(input)).toThrow(
        expect.objectContaining({ code: ErrorCode.UNSUPPORTED_CURRENCY }),
      );
    },
  );

  it('is case sensitive, so "cngn" is not cNGN', async () => {
    const registry = await loaded();
    expect(() => registry.require('cngn')).toThrow(AppError);
  });

  it('rejects a deactivated currency for new operations', async () => {
    const registry = await loaded([...DEFAULT_ROWS, row('cZWL', 'ZWL', 2, '0.6', false)]);

    expect(() => registry.require('cZWL')).toThrow(
      expect.objectContaining({ code: ErrorCode.UNSUPPORTED_CURRENCY }),
    );
    // ...but history denominated in it stays readable.
    expect(registry.find('cZWL')?.decimals).toBe(2);
    expect(registry.codes()).not.toContain('cZWL');
  });
});

describe('CurrencyRegistry lookups', () => {
  it('resolves a currency by its fiat peg, for mapping FX responses', async () => {
    const registry = await loaded();
    expect(registry.findByPeg('NGN')?.code).toBe('cNGN');
    expect(registry.findByPeg('JPY')).toBeUndefined();
  });

  it('uses the first currency by sort order when two share a peg', async () => {
    // Ambiguous pegs would make a cross rate undefined; the registry resolves it
    // deterministically rather than picking at random.
    const registry = await loaded([...DEFAULT_ROWS, row('cNGN2', 'NGN', 2, '0.9')]);
    expect(registry.findByPeg('NGN')?.code).toBe('cNGN');
  });

  it('enumerates every ordered pair including identities, for the rate matrix', async () => {
    const registry = await loaded();
    const pairs = registry.pairs();

    expect(pairs).toHaveLength(25);
    expect(new Set(pairs.map(([a, b]) => `${a.code}:${b.code}`)).size).toBe(25);
  });

  it('exposes USDx as the currency totals are quoted in', async () => {
    const registry = await loaded();
    expect(registry.usd().code).toBe('USDx');
  });

  it('excludes inactive currencies from the pair matrix', async () => {
    const registry = await loaded([...DEFAULT_ROWS, row('cZWL', 'ZWL', 2, '0.6', false)]);
    expect(registry.pairs()).toHaveLength(25);
  });
});
