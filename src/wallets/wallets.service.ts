import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { AuthService } from '../auth/auth.service';
import { AppError } from '../common/errors/app-error';
import { FxService } from '../fx/fx.service';
import { CurrencyRegistry } from '../money/currency-registry.service';
import { MoneyService } from '../money/money.service';
import { MoneyUtil } from '../money/money.util';
import { PrismaService } from '../prisma/prisma.service';
import type { PrismaTx } from '../prisma/prisma.service';
import type { WalletResponse } from './dto/wallet.response';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly fx: FxService,
    private readonly money: MoneyService,
    private readonly currencies: CurrencyRegistry,
  ) {}

  /**
   * Registers a wallet, called from `POST /auth/register`. Returns the
   * wallet alone. A caller logs in afterwards at `POST /auth/tokens`.
   * Contact uniqueness is a database unique index, not a read-then-write
   * here, so two simultaneous registrations can't both pass a pre-check.
   */
  async create(input: {
    email?: string | undefined;
    phone?: string | undefined;
    password: string;
  }): Promise<WalletResponse> {
    const contact = AuthService.requireOneContact(input);
    const { hash, salt } = await this.auth.hashPassword(input.password);
    const walletId = uuidv7();

    await this.prisma.inTransaction(async (tx) => {
      await tx.wallet.create({
        data: {
          id: walletId,
          email: contact.email,
          phone: contact.phone,
          credential: { create: { passwordHash: hash, salt } },
        },
      });
      await WalletsService.ensureBalanceRows(tx, walletId, this.currencies.codes());
    });

    return this.get(walletId);
  }

  /**
   * Creates the missing balance rows for a wallet, up front rather than
   * lazily during a movement -- inserting a row while others are already
   * locked `FOR UPDATE` is how lock-order deadlocks appear.
   */
  static async ensureBalanceRows(
    tx: PrismaTx,
    walletId: string,
    currencies: readonly string[],
  ): Promise<void> {
    if (currencies.length === 0) return;
    await tx.balance.createMany({
      data: currencies.map((currency) => ({ walletId, currency, amount: 0n })),
      skipDuplicates: true,
    });
  }

  /** The caller's wallet: every balance, plus the total in USD. */
  async get(walletId: string): Promise<WalletResponse> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      include: { balances: true },
    });

    if (!wallet || wallet.isSystem) {
      // Clearing accounts are not addressable through the API; treating one as
      // "not found" keeps their existence out of the public surface.
      throw AppError.walletNotFound(walletId);
    }

    // A currency added to the table after this wallet was created has no balance
    // row yet. Reporting it as zero is more useful than omitting it, and avoids
    // a write on a read path.
    const held = new Map(wallet.balances.map((b) => [b.currency, b.amount]));
    const rows = this.currencies.all().map((meta) => ({
      currency: meta,
      amount: held.get(meta.code) ?? 0n,
    }));

    const { asOf, source, rateTo } = await this.fx.getUsdRates();
    const usd = this.currencies.usd();

    const balances = rows.map(({ currency, amount }) => ({
      currency: currency.code,
      amount: MoneyUtil.toDecimalString(amount, currency),
      usdEquivalent: MoneyUtil.toDecimalString(
        amount === 0n
          ? 0n
          : currency.code === usd.code
            ? amount
            : MoneyUtil.convert({ amount, from: currency, to: usd, rateScaled: rateTo(currency) })
                .amount,
        usd,
      ),
    }));

    const total = this.money.totalBalancesInUsd(
      rows.map(({ currency, amount }) => ({ currency: currency.code, amount })),
      rateTo,
    );

    return {
      id: wallet.id,
      email: wallet.email,
      phone: wallet.phone,
      createdAt: wallet.createdAt.toISOString(),
      balances,
      totalUsdEquivalent: MoneyUtil.toDecimalString(total.amount, total.currency),
      totalCurrency: total.currency.code,
      ratesAsOf: asOf.toISOString(),
      ratesSource: source,
    };
  }

  /** The caller's wallets as a collection -- one today, but a list keeps a future wallet-per-purpose model non-breaking. */
  async list(walletId: string): Promise<WalletResponse[]> {
    return [await this.get(walletId)];
  }
}
