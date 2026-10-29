import { Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error';
import { FxService } from '../fx/fx.service';
import type { ResolvedRate } from '../fx/fx.types';
import { LedgerService } from '../ledger/ledger.service';
import { SystemAccountsService } from '../ledger/system-accounts.service';
import type { MovementLeg, RecordedMovement } from '../ledger/ledger.types';
import { CurrencyRegistry } from '../money/currency-registry.service';
import type { CurrencyMeta } from '../money/currency.types';
import { MoneyUtil } from '../money/money.util';
import type { PrismaTx } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import type { DepositDto, SwapDto, TransferDto } from './dto/operations.dto';
import type { TransactionResponse } from './dto/transaction.response';
import { OperationRunner, type OperationResult } from './operation.runner';

/**
 * The three money-moving operations.
 *
 * Each one does the same three things: validate its own rules, resolve a rate
 * (outside the transaction), and describe itself as a set of balanced ledger
 * legs. No balance is read or written here — LedgerService owns that, which is
 * why the locking and overdraft logic exists exactly once.
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly runner: OperationRunner,
    private readonly ledger: LedgerService,
    private readonly fx: FxService,
    private readonly currencies: CurrencyRegistry,
    private readonly system: SystemAccountsService,
  ) {}

  /**
   * A simulated deposit.
   *
   * The counter-leg debits SYSTEM_MINT — the world outside this sandbox — so the
   * movement is balanced double-entry rather than money appearing from nowhere,
   * and the total supply issued is auditable as that account's position.
   */
  async deposit(params: {
    walletId: string;
    dto: DepositDto;
    idempotencyKey: string;
    requestHash: string;
    requestId: string;
  }): Promise<OperationResult<TransactionResponse>> {
    const currency = this.currencies.require(params.dto.currency);
    const amount = MoneyUtil.toMinorUnits(params.dto.amount, currency);

    if (amount === 0n) {
      throw AppError.validationFailed({ issues: ['amount must be greater than zero'] });
    }

    const rate: ResolvedRate = {
      from: currency.code,
      to: currency.code,
      rateScaled: MoneyUtil.identityRate,
      asOf: new Date(),
      source: 'pegged',
    };

    return this.runner.run(
      {
        scope: 'POST /v1/deposits',
        walletId: params.walletId,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        requestId: params.requestId,
        type: 'DEPOSIT',
      },
      async (tx) => {
        await this.ensureRows(tx, [params.walletId], [currency]);

        const movement = await this.ledger.record(tx, {
          type: 'DEPOSIT',
          sourceWalletId: params.walletId,
          destWalletId: null,
          sourceCurrency: currency,
          sourceAmount: amount,
          destCurrency: currency,
          destAmount: amount,
          rateScaled: rate.rateScaled,
          rateSource: rate.source,
          rateAsOf: rate.asOf,
          idempotencyKey: params.idempotencyKey,
          legs: [
            { walletId: this.system.mintId, currency, direction: 'DEBIT', amount },
            { walletId: params.walletId, currency, direction: 'CREDIT', amount },
          ],
        });

        return {
          body: OperationsService.toResponse({
            movement,
            type: 'DEPOSIT',
            direction: 'CREDIT',
            sourceWalletId: params.walletId,
            destWalletId: null,
            sourceCurrency: currency,
            sourceAmount: amount,
            destCurrency: currency,
            destAmount: amount,
            rate,
          }),
          transactionId: movement.transactionId,
        };
      },
    );
  }

  /** A conversion inside one wallet. */
  async swap(params: {
    walletId: string;
    dto: SwapDto;
    idempotencyKey: string;
    requestHash: string;
    requestId: string;
  }): Promise<OperationResult<TransactionResponse>> {
    const from = this.currencies.require(params.dto.fromCurrency);
    const to = this.currencies.require(params.dto.toCurrency);

    if (from.code === to.code) {
      // Not an error of arithmetic but of intent: a same-currency swap is a
      // no-op that would still consume an idempotency key and write a ledger
      // entry pair for nothing.
      throw AppError.sameCurrencySwap(from.code);
    }

    const amount = MoneyUtil.toMinorUnits(params.dto.amount, from);
    if (amount === 0n) {
      throw AppError.validationFailed({ issues: ['amount must be greater than zero'] });
    }

    // Resolved before the transaction opens: this can make a network call, and
    // holding row locks across someone else's outage would be indefensible.
    const rate = await this.fx.resolveRate(from, to);
    const converted = MoneyUtil.convert({ amount, from, to, rateScaled: rate.rateScaled });

    if (converted.amount === 0n) {
      // Debiting the source and crediting nothing would destroy value, so this
      // is rejected rather than executed.
      throw AppError.amountTooSmallToConvert({
        from: from.code,
        to: to.code,
        amount: params.dto.amount,
      });
    }

    return this.runner.run(
      {
        scope: 'POST /v1/swaps',
        walletId: params.walletId,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        requestId: params.requestId,
        type: 'SWAP',
      },
      async (tx) => {
        await this.ensureRows(tx, [params.walletId], [from, to]);

        const movement = await this.ledger.record(tx, {
          type: 'SWAP',
          sourceWalletId: params.walletId,
          // A swap's counterparty is the wallet itself, which the database
          // CHECK on transaction shape requires.
          destWalletId: params.walletId,
          sourceCurrency: from,
          sourceAmount: amount,
          destCurrency: to,
          destAmount: converted.amount,
          rateScaled: rate.rateScaled,
          rateSource: rate.source,
          rateAsOf: rate.asOf,
          idempotencyKey: params.idempotencyKey,
          legs: OperationsService.conversionLegs({
            fxWalletId: this.system.fxId,
            payerWalletId: params.walletId,
            payeeWalletId: params.walletId,
            from,
            to,
            sourceAmount: amount,
            destAmount: converted.amount,
          }),
        });

        return {
          body: OperationsService.toResponse({
            movement,
            type: 'SWAP',
            direction: 'DEBIT',
            sourceWalletId: params.walletId,
            destWalletId: params.walletId,
            sourceCurrency: from,
            sourceAmount: amount,
            destCurrency: to,
            destAmount: converted.amount,
            rate,
          }),
          transactionId: movement.transactionId,
        };
      },
    );
  }

  /** Wallet to wallet, in the same currency or across two. */
  async transfer(params: {
    walletId: string;
    dto: TransferDto;
    idempotencyKey: string;
    requestHash: string;
    requestId: string;
  }): Promise<OperationResult<TransactionResponse>> {
    const from = this.currencies.require(params.dto.currency);
    const to = this.currencies.require(params.dto.toCurrency ?? params.dto.currency);

    if (params.dto.toWalletId === params.walletId) {
      throw AppError.selfTransfer();
    }

    const amount = MoneyUtil.toMinorUnits(params.dto.amount, from);
    if (amount === 0n) {
      throw AppError.validationFailed({ issues: ['amount must be greater than zero'] });
    }

    const rate = await this.fx.resolveRate(from, to);
    const converted = MoneyUtil.convert({ amount, from, to, rateScaled: rate.rateScaled });

    if (converted.amount === 0n) {
      throw AppError.amountTooSmallToConvert({
        from: from.code,
        to: to.code,
        amount: params.dto.amount,
      });
    }

    return this.runner.run(
      {
        scope: 'POST /v1/transfers',
        walletId: params.walletId,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        requestId: params.requestId,
        type: 'TRANSFER',
      },
      async (tx) => {
        const receiver = await tx.wallet.findUnique({ where: { id: params.dto.toWalletId } });
        if (!receiver || receiver.isSystem) {
          throw AppError.walletNotFound(params.dto.toWalletId);
        }

        await this.ensureRows(tx, [params.walletId, receiver.id], [from, to]);

        const movement = await this.ledger.record(tx, {
          type: 'TRANSFER',
          sourceWalletId: params.walletId,
          destWalletId: receiver.id,
          sourceCurrency: from,
          sourceAmount: amount,
          destCurrency: to,
          destAmount: converted.amount,
          rateScaled: rate.rateScaled,
          rateSource: rate.source,
          rateAsOf: rate.asOf,
          idempotencyKey: params.idempotencyKey,
          legs: OperationsService.conversionLegs({
            fxWalletId: this.system.fxId,
            payerWalletId: params.walletId,
            payeeWalletId: receiver.id,
            from,
            to,
            sourceAmount: amount,
            destAmount: converted.amount,
          }),
        });

        return {
          body: OperationsService.toResponse({
            movement,
            type: 'TRANSFER',
            direction: 'DEBIT',
            sourceWalletId: params.walletId,
            destWalletId: receiver.id,
            sourceCurrency: from,
            sourceAmount: amount,
            destCurrency: to,
            destAmount: converted.amount,
            rate,
          }),
          transactionId: movement.transactionId,
        };
      },
    );
  }

  /**
   * The legs of a movement that may or may not cross currencies.
   *
   * Same currency: two legs, payer to payee, and the currency nets to zero
   * directly.
   *
   * Different currencies: four legs, because a debit in cNGN and a credit in
   * USDx cannot net to zero against each other. SYSTEM_FX takes the counter-leg
   * on each side, so both currencies balance independently:
   *
   *   cNGN:  payer -1000      SYSTEM_FX +1000      = 0
   *   USDx:  SYSTEM_FX -0.62  payee     +0.62      = 0
   *
   * The conversion was floored, so SYSTEM_FX keeps slightly more source value
   * than it paid out in destination value. That difference is the rounding dust,
   * and it sits on an auditable balance rather than disappearing.
   */
  private static conversionLegs(params: {
    fxWalletId: string;
    payerWalletId: string;
    payeeWalletId: string;
    from: CurrencyMeta;
    to: CurrencyMeta;
    sourceAmount: bigint;
    destAmount: bigint;
  }): MovementLeg[] {
    if (params.from.code === params.to.code) {
      return [
        {
          walletId: params.payerWalletId,
          currency: params.from,
          direction: 'DEBIT',
          amount: params.sourceAmount,
        },
        {
          walletId: params.payeeWalletId,
          currency: params.from,
          direction: 'CREDIT',
          amount: params.sourceAmount,
        },
      ];
    }

    return [
      {
        walletId: params.payerWalletId,
        currency: params.from,
        direction: 'DEBIT',
        amount: params.sourceAmount,
      },
      {
        walletId: params.fxWalletId,
        currency: params.from,
        direction: 'CREDIT',
        amount: params.sourceAmount,
      },
      {
        walletId: params.fxWalletId,
        currency: params.to,
        direction: 'DEBIT',
        amount: params.destAmount,
      },
      {
        walletId: params.payeeWalletId,
        currency: params.to,
        direction: 'CREDIT',
        amount: params.destAmount,
      },
    ];
  }

  /**
   * Creates any missing balance rows before the movement locks anything.
   *
   * Inserting a row while other balance rows are held `FOR UPDATE` is the
   * classic route to a lock-order deadlock, so every row a movement will touch
   * is guaranteed to exist first.
   */
  private async ensureRows(
    tx: PrismaTx,
    walletIds: readonly string[],
    currencies: readonly CurrencyMeta[],
  ): Promise<void> {
    const codes = currencies.map((c) => c.code);
    for (const walletId of walletIds) {
      await WalletsService.ensureBalanceRows(tx, walletId, codes);
    }
  }

  private static toResponse(params: {
    movement: RecordedMovement;
    type: string;
    direction: string;
    sourceWalletId: string;
    destWalletId: string | null;
    sourceCurrency: CurrencyMeta;
    sourceAmount: bigint;
    destCurrency: CurrencyMeta;
    destAmount: bigint;
    rate: ResolvedRate;
  }): TransactionResponse {
    return {
      id: params.movement.transactionId,
      type: params.type,
      direction: params.direction,
      sourceWalletId: params.sourceWalletId,
      destWalletId: params.destWalletId,
      sourceCurrency: params.sourceCurrency.code,
      sourceAmount: MoneyUtil.toDecimalString(params.sourceAmount, params.sourceCurrency),
      destCurrency: params.destCurrency.code,
      destAmount: MoneyUtil.toDecimalString(params.destAmount, params.destCurrency),
      rate: MoneyUtil.rateToString(params.rate.rateScaled),
      rateSource: params.rate.source.toUpperCase(),
      rateAsOf: params.rate.asOf.toISOString(),
      createdAt: params.movement.createdAt.toISOString(),
    };
  }
}
