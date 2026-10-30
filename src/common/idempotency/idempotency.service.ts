import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService, type PrismaTx } from '../../prisma/prisma.service';
import { AppError } from '../errors/app-error';
import { toAppError } from '../errors/error-mapper';

/** A replayed response, reconstructed from the stored record. */
export interface ReplayedResponse {
  status: number;
  body: unknown;
}

/**
 * Idempotency for the three money-moving endpoints. The claim is inserted
 * **inside the operation's own database transaction** -- claimed anywhere
 * else (Redis, a separate transaction) it could outlive a rollback and
 * permanently poison the operation, since a unique constraint in the same
 * transaction as the ledger write cannot drift from it.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims a key, or reports what to do instead.
   *
   * Returns `null` when the claim succeeded and the caller should proceed.
   * Throws when the key is in flight or was reused with a different body, and
   * returns a replay when the original attempt already finished.
   */
  async claim(
    tx: PrismaTx,
    params: { scope: string; key: string; walletId: string; requestHash: string },
  ): Promise<ReplayedResponse | null> {
    // INSERT ... ON CONFLICT DO NOTHING, not insert-and-catch: a raised unique
    // violation aborts the whole PostgreSQL transaction, so reading the
    // existing record afterwards would already be doomed. `skipDuplicates`
    // turns the conflict into a row count instead.
    const { count } = await tx.idempotencyRecord.createMany({
      data: [
        {
          scope: params.scope,
          key: params.key,
          walletId: params.walletId,
          requestHash: params.requestHash,
          state: 'IN_FLIGHT',
        },
      ],
      skipDuplicates: true,
    });

    if (count === 1) return null;

    // Someone got there first. Read their record to decide between replay,
    // conflict and reuse.
    const existing = await tx.idempotencyRecord.findUnique({
      where: { scope_key: { scope: params.scope, key: params.key } },
    });

    if (!existing) {
      // The other transaction rolled back between our insert and this read.
      // Retrying is correct and will almost certainly succeed.
      throw AppError.idempotencyKeyInFlight(params.key);
    }

    if (existing.requestHash !== params.requestHash) {
      // Same key, different request. Replaying the first response would be
      // actively wrong, so this is rejected rather than served.
      throw AppError.idempotencyKeyReused(params.key);
    }

    if (existing.state === 'IN_FLIGHT') {
      throw AppError.idempotencyKeyInFlight(params.key);
    }

    if (existing.state === 'FAILED') {
      // Re-raise the stored error through the normal exception filter, so
      // this request's own id is attached but the code and details match.
      throw AppError.fromStoredFailure({
        status: existing.responseStatus ?? 422,
        body: existing.responseBody,
      });
    }

    return {
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
    };
  }

  /** Records the response to replay, in the same transaction as the movement. */
  async complete(
    tx: PrismaTx,
    params: {
      scope: string;
      key: string;
      status: number;
      body: unknown;
      transactionId?: string | undefined;
    },
  ): Promise<void> {
    await tx.idempotencyRecord.update({
      where: { scope_key: { scope: params.scope, key: params.key } },
      data: {
        state: 'COMPLETED',
        responseStatus: params.status,
        responseBody: params.body as Prisma.InputJsonValue,
        transactionId: params.transactionId ?? null,
      },
    });
  }

  /**
   * Settles a key after the operation's transaction has rolled back. A
   * deterministic failure (INSUFFICIENT_FUNDS, ...) is stored and replayed on
   * retry, since it would fail identically again; a transient one (FX
   * timeout, DB blip) is left released so a retry can succeed. Runs on a
   * fresh connection, since the original transaction is already gone.
   */
  async settleFailure(params: {
    scope: string;
    key: string;
    walletId: string;
    requestHash: string;
    error: unknown;
  }): Promise<void> {
    const appError = toAppError(params.error);

    if (appError.retryable) {
      // Deliberately nothing: the rollback already released the claim.
      return;
    }

    // Cast at the boundary: Prisma's InputJsonValue cannot express
    // Record<string, unknown>, and the shape here is known to be JSON-safe.
    const body = {
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      },
    } as unknown as Prisma.InputJsonValue;

    try {
      await this.prisma.idempotencyRecord.upsert({
        where: { scope_key: { scope: params.scope, key: params.key } },
        create: {
          scope: params.scope,
          key: params.key,
          walletId: params.walletId,
          requestHash: params.requestHash,
          state: 'FAILED',
          responseStatus: appError.status,
          responseBody: body,
        },
        update: {
          state: 'FAILED',
          responseStatus: appError.status,
          responseBody: body,
        },
      });
    } catch (writeError) {
      // Failing to record the failure must not change what the client is told
      // about their operation; at worst they get the same deterministic error
      // recomputed on retry.
      this.logger.warn(
        `Could not record failed idempotency key ${params.key}: ${(writeError as Error).message}`,
      );
    }
  }
}
