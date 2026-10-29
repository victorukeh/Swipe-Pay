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
import type { CreateWalletResponse, WalletResponse } from './dto/wallet.response';

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
   * Creates a wallet and returns it with a token pair, so creating and first
   * using a wallet is one round trip.
   *
   * Uniqueness of the email or phone is enforced by unique indexes in the
   * database, not by a read-then-write here: two simultaneous registrations with
   * the same address would both pass a pre-check and both insert. The unique
   * violation is mapped to WALLET_CONTACT_TAKEN by the error mapper.
   */
  async create(input: {
    email?: string | undefined;
    phone?: string | undefined;
    password: string;
  }): Promise<CreateWalletResponse> {
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

    const wallet = await this.get(walletId);
    const tokens = await this.auth.issuePair(walletId);
    return { ...wallet, tokens };
  }

  /**
   * Creates the missing balance rows for a wallet.
   *
   * Done up front rather than lazily during a movement, because inserting a row
   * while other balance rows are already locked `FOR UPDATE` is how lock-order
   * deadlocks appear. `skipDuplicates` makes it safe to call repeatedly, which
   * matters after a currency is added to the table.
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

  /**
   * The caller's wallets as a collection.
   *
   * One today. It is a list rather than a bare object because the URI names a
   * collection, and because a wallet-per-purpose model is a plausible extension
   * that would not then need a breaking change.
   */
  async list(walletId: string): Promise<WalletResponse[]> {
    return [await this.get(walletId)];
  }
}
