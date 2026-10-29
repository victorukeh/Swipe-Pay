import type { TransactionType } from '@prisma/client';

import type { CurrencyMeta } from '../money/currency.types';
import type { RateSourceName } from '../fx/fx.types';

export type LegDirection = 'DEBIT' | 'CREDIT';

/** One side of a movement. The sign lives in `direction`; `amount` is positive. */
export interface MovementLeg {
  readonly walletId: string;
  readonly currency: CurrencyMeta;
  readonly direction: LegDirection;
  readonly amount: bigint;
}

/**
 * A complete, balanced money movement.
 *
 * `legs` must sum to zero within each currency — LedgerService asserts it rather
 * than trusting the caller, because an unbalanced movement is the one bug that
 * would quietly break every audit downstream.
 */
export interface MovementSpec {
  readonly type: TransactionType;
  /** The wallet whose statement this movement belongs to. */
  readonly sourceWalletId: string;
  /** The counterparty, for a transfer. Null for a deposit; self for a swap. */
  readonly destWalletId: string | null;

  readonly sourceCurrency: CurrencyMeta;
  readonly sourceAmount: bigint;
  readonly destCurrency: CurrencyMeta;
  readonly destAmount: bigint;

  readonly rateScaled: bigint;
  readonly rateSource: RateSourceName;
  readonly rateAsOf: Date;

  readonly idempotencyKey: string | null;
  readonly legs: readonly MovementLeg[];
}

/** What a committed movement looks like coming back out. */
export interface RecordedMovement {
  readonly transactionId: string;
  readonly createdAt: Date;
  readonly balancesAfter: ReadonlyMap<string, bigint>;
}

/** Composite key of a balance row: the unit of locking. */
export function balanceKey(walletId: string, currency: string): string {
  return `${walletId}:${currency}`;
}
