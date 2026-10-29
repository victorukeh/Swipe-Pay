import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

import { CURRENCY_CODES } from '../src/money/currencies';

const prisma = new PrismaClient();

/**
 * The rounding account.
 *
 * Converting between currencies with different scales leaves a residual that
 * cannot be credited to the user (crediting it up would mint money; dropping it
 * would break double-entry). It is posted here instead, which keeps the
 * invariant "the signed sum of every ledger entry in a currency is zero" true —
 * that is exactly what the ledger invariant test asserts.
 */
export const SYSTEM_ROUNDING_KEY = 'SYSTEM_ROUNDING';

async function main(): Promise<void> {
  const existing = await prisma.wallet.findUnique({
    where: { systemKey: SYSTEM_ROUNDING_KEY },
  });

  const wallet =
    existing ??
    (await prisma.wallet.create({
      data: { id: uuidv7(), systemKey: SYSTEM_ROUNDING_KEY, isSystem: true },
    }));

  // Pre-create a balance row per currency so the rounding account never needs a
  // row to be inserted mid-transaction while balance rows are locked.
  await prisma.balance.createMany({
    data: CURRENCY_CODES.map((currency) => ({ walletId: wallet.id, currency, amount: 0n })),
    skipDuplicates: true,
  });

  console.log(
    existing
      ? `seed: ${SYSTEM_ROUNDING_KEY} wallet already present (${wallet.id})`
      : `seed: created ${SYSTEM_ROUNDING_KEY} wallet (${wallet.id})`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
