import { Injectable, Logger } from '@nestjs/common';
import type { TransactionType } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

import { toAppError } from '../common/errors/error-mapper';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { PrismaService, type PrismaTx } from '../prisma/prisma.service';

export interface OperationContext {
  /** Route-level namespace, so the same key may be used on two endpoints. */
  readonly scope: string;
  readonly walletId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string;
  readonly type: TransactionType;
}

export interface OperationResult<T> {
  readonly status: number;
  readonly body: T;
  /** True when this response came from a stored record rather than fresh work. */
  readonly replayed: boolean;
}

/**
 * The shared spine of every money-moving endpoint: claiming the idempotency
 * key, running inside one transaction, recording the attempt, and settling
 * the key on failure, all exactly once. Deposit, swap and transfer differ
 * only in which legs they produce.
 *
 * FX resolution is deliberately *not* inside the transaction -- a rate
 * lookup can make a network call, and holding row locks across someone
 * else's outage would be indefensible. Callers resolve their rate first.
 */
@Injectable()
export class OperationRunner {
  private readonly logger = new Logger(OperationRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async run<T>(
    ctx: OperationContext,
    work: (tx: PrismaTx) => Promise<{ body: T; transactionId: string }>,
  ): Promise<OperationResult<T>> {
    try {
      return await this.prisma.inTransaction(async (tx) => {
        const replay = await this.idempotency.claim(tx, {
          scope: ctx.scope,
          key: ctx.idempotencyKey,
          walletId: ctx.walletId,
          requestHash: ctx.requestHash,
        });

        if (replay !== null) {
          // The original attempt already finished. Return exactly what it
          // returned, so a retry is indistinguishable from the first call.
          return { status: replay.status, body: replay.body as T, replayed: true };
        }

        const { body, transactionId } = await work(tx);

        await this.idempotency.complete(tx, {
          scope: ctx.scope,
          key: ctx.idempotencyKey,
          status: 201,
          body,
          transactionId,
        });

        // Written inside the transaction, so a successful attempt record can
        // never disagree with the money it describes.
        await tx.transactionAttempt.create({
          data: {
            id: uuidv7(),
            walletId: ctx.walletId,
            type: ctx.type,
            outcome: 'SUCCEEDED',
            requestHash: ctx.requestHash,
            idempotencyKey: ctx.idempotencyKey,
            transactionId,
            requestId: ctx.requestId,
          },
        });

        return { status: 201, body, replayed: false };
      });
    } catch (error) {
      await this.recordFailure(ctx, error);
      throw error;
    }
  }

  /**
   * Everything that has to happen after the transaction has rolled back.
   * Both writes go out on a fresh connection -- a row inside the doomed
   * transaction would have disappeared with it, which is why failures are
   * audited in `transaction_attempts` rather than as a status on `transactions`.
   */
  private async recordFailure(ctx: OperationContext, error: unknown): Promise<void> {
    const appError = toAppError(error);

    await this.idempotency.settleFailure({
      scope: ctx.scope,
      key: ctx.idempotencyKey,
      walletId: ctx.walletId,
      requestHash: ctx.requestHash,
      error,
    });

    try {
      await this.prisma.transactionAttempt.create({
        data: {
          id: uuidv7(),
          walletId: ctx.walletId,
          type: ctx.type,
          outcome: 'FAILED',
          requestHash: ctx.requestHash,
          idempotencyKey: ctx.idempotencyKey,
          errorCode: appError.code,
          errorMessage: appError.message,
          requestId: ctx.requestId,
        },
      });
    } catch (writeError) {
      // Audit is best-effort on the failure path. The client still gets the
      // right error, and the request id is in the log either way.
      this.logger.warn(
        `Could not record failed attempt for ${ctx.requestId}: ${(writeError as Error).message}`,
      );
    }
  }
}
