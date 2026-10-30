import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

/**
 * Clearing accounts: the counter-leg for a movement with no wallet on the
 * far side. SYSTEM_MINT is the external world (debited on deposit);
 * SYSTEM_FX takes both sides of a conversion, keeping each currency's
 * signed sum at zero. Both legitimately run negative (allow_negative).
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
  /** Fractional index, as a string -- a JSON number would re-introduce float error into a NUMERIC column. */
  sortOrder: string;
}

/** Resolved from the working directory (project root in both dev and the container), not __dirname. */
function loadCurrencies(): CurrencySeed[] {
  const file =
    process.env.CURRENCY_SEED_FILE ?? join(process.cwd(), 'prisma', 'seeds', 'currencies.json');
  return JSON.parse(readFileSync(file, 'utf8')) as CurrencySeed[];
}

/**
 * Upserts currencies, deliberately leaving `decimals` alone on existing rows
 * -- the trigger would refuse a precision change anyway, but the seed
 * shouldn't even try.
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
