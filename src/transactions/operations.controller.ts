import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiEnvelope, ApiEnvelopeError } from '../common/http/response-envelope';
import { ResponseMessage } from '../common/interceptors/response-envelope.interceptor';
import type { Response } from 'express';

import { CurrentWallet } from '../auth/current-wallet.decorator';
import { ApiIdempotencyKey, IdempotencyKey } from '../common/idempotency/idempotency-key.decorator';
import { hashRequest } from '../common/idempotency/request-hash';
import { RequestId } from '../common/request-id.decorator';
import type { AuthenticatedWallet } from '../common/request-context';
import { DepositDto, SwapDto, TransferDto } from './dto/operations.dto';
import { TransactionResponse } from './dto/transaction.response';
import { OperationsService } from './operations.service';
import type { OperationResult } from './operation.runner';

/**
 * The three money-moving endpoints.
 *
 * All top-level siblings rather than nested under /wallets: the sender is always
 * the token holder, so there is no wallet id to nest them under, and `/transfers`
 * would read oddly if the other two lived somewhere else.
 */
@ApiTags('operations')
@ApiBearerAuth()
@Controller()
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Post('deposits')
  @HttpCode(HttpStatus.CREATED)
  @ApiIdempotencyKey()
  @ApiOperation({
    summary: 'Deposit funds (simulated)',
    description:
      'Credits the wallet immediately and writes a transaction record. The counter-leg debits an ' +
      'internal clearing account, so the movement is balanced double-entry rather than money ' +
      'appearing from nowhere.',
  })
  @ApiEnvelope(TransactionResponse, { status: 201 })
  @ApiEnvelopeError(400, 'IDEMPOTENCY_KEY_REQUIRED, VALIDATION_FAILED or INVALID_AMOUNT')
  @ApiEnvelopeError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT')
  @ApiEnvelopeError(
    422,
    'UNSUPPORTED_CURRENCY, AMOUNT_PRECISION_EXCEEDED or IDEMPOTENCY_KEY_REUSED',
  )
  @ResponseMessage('Deposit completed')
  async deposit(
    @CurrentWallet() wallet: AuthenticatedWallet,
    @Body() dto: DepositDto,
    @IdempotencyKey() idempotencyKey: string,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransactionResponse> {
    return OperationsController.send(
      res,
      await this.operations.deposit({
        walletId: wallet.walletId,
        dto,
        idempotencyKey,
        requestHash: hashRequest(dto),
        requestId,
      }),
    );
  }

  @Post('swaps')
  @HttpCode(HttpStatus.CREATED)
  @ApiIdempotencyKey()
  @ApiOperation({
    summary: 'Swap one stablecoin for another inside the wallet',
    description:
      'Converts at the current rate. The amount credited is floored to the destination ' +
      "currency's precision, so the system can never credit more value than it debited. A swap " +
      'that would round to zero is rejected rather than executed.',
  })
  @ApiEnvelope(TransactionResponse, { status: 201 })
  @ApiEnvelopeError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT')
  @ApiEnvelopeError(
    422,
    'INSUFFICIENT_FUNDS, SAME_CURRENCY_SWAP, AMOUNT_TOO_SMALL_TO_CONVERT, ' +
      'UNSUPPORTED_CURRENCY or AMOUNT_PRECISION_EXCEEDED',
  )
  @ApiEnvelopeError(503, 'RATE_UNAVAILABLE')
  @ResponseMessage('Swap completed')
  async swap(
    @CurrentWallet() wallet: AuthenticatedWallet,
    @Body() dto: SwapDto,
    @IdempotencyKey() idempotencyKey: string,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransactionResponse> {
    return OperationsController.send(
      res,
      await this.operations.swap({
        walletId: wallet.walletId,
        dto,
        idempotencyKey,
        requestHash: hashRequest(dto),
        requestId,
      }),
    );
  }

  @Post('transfers')
  @HttpCode(HttpStatus.CREATED)
  @ApiIdempotencyKey()
  @ApiOperation({
    summary: 'Send funds to another wallet, in the same or a different currency',
    description:
      'The sender is the token holder. When `toCurrency` differs from `currency` the amount is ' +
      'converted at the current rate, and the record keeps sender, receiver, both amounts, both ' +
      'currencies, the rate applied and a timestamp.',
  })
  @ApiEnvelope(TransactionResponse, { status: 201 })
  @ApiEnvelopeError(409, 'IDEMPOTENCY_KEY_IN_FLIGHT')
  @ApiEnvelopeError(
    422,
    'INSUFFICIENT_FUNDS, SELF_TRANSFER, AMOUNT_TOO_SMALL_TO_CONVERT or UNSUPPORTED_CURRENCY',
  )
  @ApiEnvelopeError(503, 'RATE_UNAVAILABLE')
  @ResponseMessage('Transfer completed')
  async transfer(
    @CurrentWallet() wallet: AuthenticatedWallet,
    @Body() dto: TransferDto,
    @IdempotencyKey() idempotencyKey: string,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransactionResponse> {
    return OperationsController.send(
      res,
      await this.operations.transfer({
        walletId: wallet.walletId,
        dto,
        idempotencyKey,
        requestHash: hashRequest(dto),
        requestId,
      }),
    );
  }

  /**
   * A replay is flagged in a header rather than by changing the body.
   *
   * The body is byte-identical to the original response, which is the entire
   * point of idempotency; `Idempotency-Replayed` lets a client tell the
   * difference when it cares, without having to.
   */
  private static send(
    res: Response,
    result: OperationResult<TransactionResponse>,
  ): TransactionResponse {
    res.setHeader('Idempotency-Replayed', result.replayed ? 'true' : 'false');
    res.status(result.status);
    return result.body;
  }
}
