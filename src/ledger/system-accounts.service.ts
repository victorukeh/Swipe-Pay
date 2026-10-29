import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { AppError } from '../common/errors/app-error';
import { CurrencyRegistry } from '../money/currency-registry.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The internal clearing accounts, resolved once at boot.
 *
 * Double-entry needs a counterparty for movements that have no second wallet:
 *
 *   SYSTEM_MINT  the external world. A deposit debits it, so the total supply
 *                this sandbox has issued is auditable as its position.
 *   SYSTEM_FX    the conversion book. A cross-currency movement credits it the
 *                source currency and debits it the destination currency.
 *
 * SYSTEM_FX is what makes "the signed sum of every ledger entry in a currency is
 * exactly zero" hold for conversions, which could never be true of a single
 * account spanning two currencies. It is also where the sub-minor-unit rounding
 * dust accrues: flooring a conversion leaves less than one minor unit that
 * cannot be credited to the user, and rather than vanishing it stays on this
 * account's balance where it can be audited.
 */
export const SYSTEM_MINT_KEY = 'SYSTEM_MINT';
export const SYSTEM_FX_KEY = 'SYSTEM_FX';

@Injectable()
export class SystemAccountsService implements OnModuleInit {
  private readonly logger = new Logger(SystemAccountsService.name);
  private ids = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrencyRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    for (const key of [SYSTEM_MINT_KEY, SYSTEM_FX_KEY]) {
      const wallet = await this.prisma.wallet.findUnique({ where: { systemKey: key } });
      if (!wallet) {
        const detail = `Clearing account ${key} is missing. Run \`yarn db:seed\`.`;
        this.logger.error(detail);
        throw AppError.internal(new Error(detail));
      }
      this.ids.set(key, wallet.id);

      // A currency added to the table after seeding needs a row here too, and it
      // must allow a negative position. Created now rather than mid-transaction,
      // because inserting while balance rows are locked is how lock-order
      // deadlocks appear.
      await this.prisma.balance.createMany({
        data: this.currencies.codes().map((currency) => ({
          walletId: wallet.id,
          currency,
          amount: 0n,
          allowNegative: true,
        })),
        skipDuplicates: true,
      });
    }

    this.logger.log(`Clearing accounts ready: ${[...this.ids.keys()].join(', ')}`);
  }

  /** The account a deposit draws from: the world outside this sandbox. */
  get mintId(): string {
    return this.idOf(SYSTEM_MINT_KEY);
  }

  /** The account that holds both legs of a conversion. */
  get fxId(): string {
    return this.idOf(SYSTEM_FX_KEY);
  }

  private idOf(key: string): string {
    const id = this.ids.get(key);
    if (id === undefined) throw AppError.internal(new Error(`Clearing account ${key} not loaded`));
    return id;
  }
}
