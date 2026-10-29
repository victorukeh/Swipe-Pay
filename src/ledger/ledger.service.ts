import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

import { AppError } from '../common/errors/app-error';
import { MoneyUtil } from '../money/money.util';
import type { PrismaTx } from '../prisma/prisma.service';
import {
  balanceKey,
  type MovementLeg,
  type MovementSpec,
  type RecordedMovement,
} from './ledger.types';

/** A locked balance row, as returned by the SELECT ... FOR UPDATE. */
interface LockedBalance {
  wallet_id: string;
  currency: string;
  amount: bigint;
  allow_negative: boolean;
}

/**
 * The only writer of `balances`, `ledger_entries` and `transactions`.
 *
 * Deposits, swaps and transfers all describe themselves as a set of legs and
 * hand them here, so the locking, the ordering, the overdraft check and the
 * double-entry write exist exactly once. None of those three services contains a
 * balance update.
 *
 * ## Why it is safe under concurrency
 *
 * Everything happens in one transaction supplied by the caller, and the affected
 * balance rows are taken with `SELECT ... FOR UPDATE` **ordered by
 * (wallet_id, currency)** before anything is read for a decision. Two concurrent
 * movements touching the same rows therefore serialise behind the lock rather
 * than both reading a stale balance, and two opposing transfers (A to B, B to A)
 * cannot deadlock because both acquire their locks in the same order.
 *
 * ## Why the debit leg goes first
 *
 * Atomicity comes from the transaction boundary, not from leg order: if the
 * credit fails the debit rolls back, so there is no state in which money has
 * left the sender and not arrived. The order still matters for two other
 * reasons. The debit is the only leg that can be *rejected*, so applying it
 * first means INSUFFICIENT_FUNDS surfaces before any further work; and
 * `balanceAfter` snapshots are only reproducible under a deterministic order.
 */
@Injectable()
export class LedgerService {
  /**
   * Applies a balanced movement, returning the transaction it produced.
   *
   * The caller must already be inside `PrismaService.inTransaction`.
   */
  async record(tx: PrismaTx, spec: MovementSpec): Promise<RecordedMovement> {
    LedgerService.assertBalanced(spec);

    const legs = LedgerService.orderLegs(spec.legs);
    const locked = await LedgerService.lockBalances(tx, legs);

    const transactionId = uuidv7();
    const balancesAfter = new Map<string, bigint>();
    const entries: Prisma.LedgerEntryCreateManyInput[] = [];

    for (const leg of legs) {
      const key = balanceKey(leg.walletId, leg.currency.code);
      const row = locked.get(key);

      if (row === undefined) {
        // Only reachable if a caller passed a wallet whose balance row was never
        // created, which the operation services do up front.
        throw AppError.internal(
          new Error(`No balance row for ${key}; it must be created before the movement`),
        );
      }

      const current = balancesAfter.get(key) ?? row.amount;
      const next = leg.direction === 'DEBIT' ? current - leg.amount : current + leg.amount;

      if (next < 0n && !row.allow_negative) {
        // Belt and braces with the database CHECK: this produces a precise
        // INSUFFICIENT_FUNDS with the figures, rather than a constraint error.
        throw AppError.insufficientFunds({
          currency: leg.currency.code,
          requested: MoneyUtil.toDecimalString(leg.amount, leg.currency),
          available: MoneyUtil.toDecimalString(current, leg.currency),
        });
      }

      balancesAfter.set(key, next);
      entries.push({
        id: uuidv7(),
        transactionId,
        walletId: leg.walletId,
        currency: leg.currency.code,
        direction: leg.direction,
        amount: leg.amount,
        balanceAfter: next,
      });
    }

    const transaction = await tx.transaction.create({
      data: {
        id: transactionId,
        type: spec.type,
        sourceWalletId: spec.sourceWalletId,
        destWalletId: spec.destWalletId,
        sourceCurrency: spec.sourceCurrency.code,
        sourceAmount: spec.sourceAmount,
        destCurrency: spec.destCurrency.code,
        destAmount: spec.destAmount,
        rateScaled: spec.rateScaled,
        rateSource: LedgerService.toRateSource(spec.rateSource),
        rateAsOf: spec.rateAsOf,
        idempotencyKey: spec.idempotencyKey,
      },
    });

    await tx.ledgerEntry.createMany({ data: entries });

    // Balances are written last, from the already-computed projection, so the
    // ledger is the thing that determines them rather than the reverse.
    for (const [key, amount] of balancesAfter) {
      const [walletId, currency] = LedgerService.splitKey(key);
      await tx.balance.update({
        where: { walletId_currency: { walletId, currency } },
        data: { amount },
      });
    }

    return { transactionId, createdAt: transaction.createdAt, balancesAfter };
  }

  /**
   * Debits before credits, then a stable order within each group.
   *
   * Sorting here rather than trusting the caller means every operation gets
   * fail-fast overdraft behaviour and reproducible `balanceAfter` values,
   * whatever order it happened to list its legs in.
   */
  private static orderLegs(legs: readonly MovementLeg[]): MovementLeg[] {
    return [...legs].sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === 'DEBIT' ? -1 : 1;
      if (a.walletId !== b.walletId) return a.walletId < b.walletId ? -1 : 1;
      return a.currency.code < b.currency.code ? -1 : 1;
    });
  }

  /**
   * Takes a row lock on every balance the movement touches, in a fixed order.
   *
   * The ORDER BY is the deadlock defence. Postgres acquires row locks in the
   * order rows are produced, so two transactions that both lock
   * (wallet_id, currency) ascending can never hold a lock the other is waiting
   * for. Raw SQL because `FOR UPDATE` has no expression in the Prisma query API.
   */
  private static async lockBalances(
    tx: PrismaTx,
    legs: readonly MovementLeg[],
  ): Promise<Map<string, LockedBalance>> {
    const keys = [
      ...new Map(
        legs.map((leg) => [
          balanceKey(leg.walletId, leg.currency.code),
          { walletId: leg.walletId, currency: leg.currency.code },
        ]),
      ).values(),
    ];

    const tuples = Prisma.join(
      keys.map((key) => Prisma.sql`(${key.walletId}::uuid, ${key.currency})`),
    );

    const rows = await tx.$queryRaw<LockedBalance[]>`
      SELECT "wallet_id", "currency", "amount", "allow_negative"
      FROM "balances"
      WHERE ("wallet_id", "currency") IN (${tuples})
      ORDER BY "wallet_id", "currency"
      FOR UPDATE
    `;

    return new Map(rows.map((row) => [balanceKey(row.wallet_id, row.currency), row]));
  }

  /**
   * Refuses an unbalanced movement.
   *
   * Every currency must net to zero across the legs. This is the invariant the
   * whole audit story rests on, and it is cheap to check here — far cheaper than
   * discovering months later that the ledger does not reconcile.
   */
  private static assertBalanced(spec: MovementSpec): void {
    const net = new Map<string, bigint>();

    for (const leg of spec.legs) {
      if (leg.amount <= 0n) {
        throw AppError.internal(
          new Error(`Ledger legs must be positive; got ${leg.amount.toString()}`),
        );
      }
      const delta = leg.direction === 'DEBIT' ? -leg.amount : leg.amount;
      net.set(leg.currency.code, (net.get(leg.currency.code) ?? 0n) + delta);
    }

    for (const [currency, sum] of net) {
      if (sum !== 0n) {
        throw AppError.internal(
          new Error(`Movement does not balance in ${currency}: net ${sum.toString()}`),
        );
      }
    }
  }

  private static splitKey(key: string): [string, string] {
    const index = key.lastIndexOf(':');
    return [key.slice(0, index), key.slice(index + 1)];
  }

  /** Maps our rate-source name onto the database enum. */
  private static toRateSource(source: string): Prisma.TransactionCreateInput['rateSource'] {
    switch (source) {
      case 'live':
        return 'LIVE';
      case 'cached':
        return 'CACHED';
      case 'stale':
        return 'STALE';
      case 'fallback':
        return 'FALLBACK';
      case 'pegged':
        return 'PEGGED';
      default:
        throw AppError.internal(new Error(`Unknown rate source ${source}`));
    }
  }
}
