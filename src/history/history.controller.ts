import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentWallet } from '../auth/current-wallet.decorator';
import type { AuthenticatedWallet } from '../common/request-context';
import { AttemptHistoryQuery, TransactionHistoryQuery } from './dto/history.query';
import {
  AttemptPageResponse,
  HistoryEntryResponse,
  TransactionPageResponse,
} from './dto/history.response';
import { HistoryService } from './history.service';

@ApiTags('history')
@ApiBearerAuth()
@Controller()
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('transactions')
  @ApiOperation({
    summary: "The caller's transactions, newest first",
    description:
      'Deposits, swaps, and transfers both sent and received, with cursor pagination and ' +
      'filtering by type, currency and direction. Built from the ledger, so one transfer appears ' +
      "as sent in the sender's statement and received in the receiver's, and a cross-currency " +
      'swap appears as two rows -- a debit and a credit -- in the same statement.',
  })
  @ApiOkResponse({ type: TransactionPageResponse })
  async list(
    @CurrentWallet() wallet: AuthenticatedWallet,
    @Query() query: TransactionHistoryQuery,
  ): Promise<TransactionPageResponse> {
    return this.history.listTransactions(wallet.walletId, query);
  }

  @Get('transactions/:id')
  @ApiOperation({
    summary: 'Fetch a single transaction by id',
    description:
      'Visible to either party, so a receiver can read a transfer sent to them. A caller who is ' +
      'party to neither gets FORBIDDEN_WALLET_ACCESS.',
  })
  @ApiOkResponse({ type: HistoryEntryResponse })
  @ApiNotFoundResponse({ description: 'TRANSACTION_NOT_FOUND' })
  @ApiForbiddenResponse({ description: 'FORBIDDEN_WALLET_ACCESS' })
  async get(
    @CurrentWallet() wallet: AuthenticatedWallet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HistoryEntryResponse> {
    return this.history.getTransaction(wallet.walletId, id);
  }

  @Get('attempts')
  @ApiOperation({
    summary: 'The attempt log, including attempts that moved no money',
    description:
      'Kept separate from /transactions because the two carry different guarantees: transactions ' +
      'only ever hold committed money, which is what keeps the per-currency ledger sum provable, ' +
      'so failures are audited here instead. Each row carries the requestId the client saw.',
  })
  @ApiOkResponse({ type: AttemptPageResponse })
  async attempts(
    @CurrentWallet() wallet: AuthenticatedWallet,
    @Query() query: AttemptHistoryQuery,
  ): Promise<AttemptPageResponse> {
    return this.history.listAttempts(wallet.walletId, query);
  }
}
