import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

/**
 * Clearing accounts.
 *
 * Double-entry needs somewhere for the counter-leg of a movement that has no
 * other wallet on the far side:
 *
 *  - SYSTEM_MINT is the external world. A deposit debits it, so the total supply
 *    this sandbox has issued is auditable as that account's position.
 *  - SYSTEM_FX takes both sides of a conversion: it is credited the source
 *    currency and debited the destination currency. This is what makes "the
 *    signed sum of every ledger entry in a currency is zero" hold even for
 *    cross-currency movements, and it is where the sub-minor-unit rounding dust
 *    accrues rather than vanishing.
 *
 * Both legitimately hold negative positions, which is why their balance rows
 * carry allow_negative.
 */
export const SYSTEM_MINT_KEY = 'SYSTEM_MINT';
export const SYSTEM_FX_KEY = 'SYSTEM_FX';
const SYSTEM_KEYS = [SYSTEM_MINT_KEY, SYSTEM_FX_KEY] as const;

interface CurrencySeed {
  code: string;
  peg: string;
  decimals: number;
  name: string;
  minorUnit: string;
  /**
   * Fractional index, as a string.
   *
   * A string in the JSON on purpose: JSON numbers are IEEE-754 doubles, so
   * writing 0.1 here and letting the parser produce 0.1000000000000000055 would
   * defeat the point of the column being NUMERIC. Prisma accepts a string for a
   * Decimal field and stores it exactly.
   */
  sortOrder: string;
}

/**
 * Resolved from the working directory, not from __dirname.
 *
 * The same file has to be found whether this runs as TypeScript from the repo
 * root in development or as compiled JavaScript from /app in the container,
 * where __dirname is /app/dist. The working directory is the project root in
 * both cases.
 */
function loadCurrencies(): CurrencySeed[] {
  const file =
    process.env.CURRENCY_SEED_FILE ?? join(process.cwd(), 'prisma', 'seeds', 'currencies.json');
  return JSON.parse(readFileSync(file, 'utf8')) as CurrencySeed[];
}

/**
 * Seeding currencies is an upsert that deliberately leaves `decimals` alone on
 * rows that already exist.
 *
 * Re-running the seed must never change the precision of a currency that already
 * has money behind it — the database trigger would refuse it anyway, but the
 * seed should not even try. New currencies are added by editing
 * prisma/seeds/currencies.json; changing an existing currency's precision is not
 * a seed operation.
 */
async function seedCurrencies(prisma: PrismaClient, log: boolean): Promise<string[]> {
  const seeds = loadCurrencies();

  for (const seed of seeds) {
    await prisma.currency.upsert({
      where: { code: seed.code },
      create: seed,
      update: {
        peg: seed.peg,
        name: seed.name,
        minorUnit: seed.minorUnit,
        sortOrder: seed.sortOrder,
        isActive: true,
      },
    });
  }

  if (log) {
    console.log(
      `seed: ${seeds.length} currencies present (${seeds.map((s) => s.code).join(', ')})`,
    );
  }
  return seeds.map((s) => s.code);
}

async function seedSystemWallets(
  prisma: PrismaClient,
  currencyCodes: string[],
  log: boolean,
): Promise<void> {
  for (const systemKey of SYSTEM_KEYS) {
    const existing = await prisma.wallet.findUnique({ where: { systemKey } });
    const wallet =
      existing ??
      (await prisma.wallet.create({ data: { id: uuidv7(), systemKey, isSystem: true } }));

    // Pre-create a balance row per currency so a clearing account never needs a
    // row inserted mid-transaction while other balance rows are locked.
    await prisma.balance.createMany({
      data: currencyCodes.map((currency) => ({
        walletId: wallet.id,
        currency,
        amount: 0n,
        allowNegative: true,
      })),
      skipDuplicates: true,
    });

    if (log) {
      console.log(
        existing
          ? `seed: ${systemKey} already present (${wallet.id})`
          : `seed: created ${systemKey} (${wallet.id})`,
      );
    }
  }
}

/**
 * Exported so the test harness can seed its own database without shelling out
 * to a package manager, which is not guaranteed to be on PATH.
 */
export async function runSeed(prisma: PrismaClient, log = true): Promise<void> {
  const codes = await seedCurrencies(prisma, log);
  await seedSystemWallets(prisma, codes, log);
}

/** CLI entry point. Only runs when this file is executed directly. */
if (require.main === module) {
  const prisma = new PrismaClient();
  runSeed(prisma)
    .catch((error: unknown) => {
      console.error('seed failed:', error);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
