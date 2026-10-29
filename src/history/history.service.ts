import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppError } from '../common/errors/app-error';
import { decodeCursor, toPage, type Page } from '../common/pagination/cursor';
import { CurrencyRegistry } from '../money/currency-registry.service';
import { MoneyUtil } from '../money/money.util';
import { PrismaService } from '../prisma/prisma.service';
import type { AttemptHistoryQuery, TransactionHistoryQuery } from './dto/history.query';
import type { AttemptResponse, HistoryEntryResponse } from './dto/history.response';

/** A ledger entry joined to its transaction — the shape a statement row needs. */
interface EntryRow {
  id: string;
  createdAt: Date;
  direction: 'DEBIT' | 'CREDIT';
  currency: string;
  amount: bigint;
  balanceAfter: bigint;
  transaction: {
    id: string;
    type: 'DEPOSIT' | 'SWAP' | 'TRANSFER';
    sourceWalletId: string;
    destWalletId: string | null;
    sourceCurrency: string;
    sourceAmount: bigint;
    destCurrency: string;
    destAmount: bigint;
    rateScaled: bigint;
    rateSource: string;
    rateAsOf: Date;
    createdAt: Date;
  };
}

@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrencyRegistry,
  ) {}

  /**
   * A wallet's statement, newest first.
   *
   * Queried over `ledger_entries` rather than `transactions`, which is what
   * makes a single transfer read correctly as *sent* for one wallet and
   * *received* for the other without being stored twice. It also means a
   * cross-currency swap appears as two rows in one wallet's statement — a debit
   * in the source currency and a credit in the destination — which is what a
   * statement should show, and what makes filtering by currency meaningful.
   */
  async listTransactions(
    walletId: string,
    query: TransactionHistoryQuery,
  ): Promise<Page<HistoryEntryResponse>> {
    const limit = query.limit ?? 20;
    const currency =
      query.currency === undefined ? undefined : this.currencies.require(query.currency).code;

    const where: Prisma.LedgerEntryWhereInput = {
      walletId,
      ...(currency === undefined ? {} : { currency }),
      ...(query.direction === undefined ? {} : { direction: query.direction }),
      ...(query.type === undefined ? {} : { transaction: { type: query.type } }),
      ...HistoryService.cursorFilter(query.cursor),
    };

    const rows = (await this.prisma.ledgerEntry.findMany({
      where,
      include: { transaction: true },
      // Matches the (wallet_id, created_at DESC, id) index, so the page boundary
      // is resolved by an index scan rather than a sort.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })) as unknown as EntryRow[];

    const page = toPage(rows, limit);
    return {
      items: page.items.map((row) => this.toHistoryEntry(row)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /**
   * A single transaction, visible to either party.
   *
   * Authorised against both sides rather than just the initiator, so a receiver
   * can read a transfer that was sent to them. A caller who is party to neither
   * gets FORBIDDEN_WALLET_ACCESS — distinct from NOT_FOUND on purpose, because
   * the two are genuinely different situations and the ids are unguessable
   * UUIDv7 anyway.
   */
  async getTransaction(walletId: string, transactionId: string): Promise<HistoryEntryResponse> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { entries: { where: { walletId }, orderBy: { direction: 'asc' } } },
    });

    if (!transaction) throw AppError.transactionNotFound(transactionId);

    const isParty =
      transaction.sourceWalletId === walletId || transaction.destWalletId === walletId;
    if (!isParty) throw AppError.forbiddenWalletAccess();

    const entry = transaction.entries[0];
    if (!entry) {
      // Party to the transaction but with no ledger entry of their own: only
      // possible for malformed data, so treat it as not visible.
      throw AppError.forbiddenWalletAccess();
    }

    return this.toHistoryEntry({ ...entry, transaction });
  }

  /**
   * The attempt log: every try, including the ones that moved no money.
   *
   * Separate from `/transactions` because the two carry different guarantees.
   * `transactions` only ever holds committed money, which is what keeps the
   * per-currency ledger sum provable; failures could not live there without
   * breaking that, so they live here.
   */
  async listAttempts(walletId: string, query: AttemptHistoryQuery): Promise<Page<AttemptResponse>> {
    const limit = query.limit ?? 20;

    const rows = await this.prisma.transactionAttempt.findMany({
      where: {
        walletId,
        ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...HistoryService.cursorFilter(query.cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = toPage(rows, limit);
    return {
      items: page.items.map((row) => ({
        id: row.id,
        type: row.type,
        outcome: row.outcome,
        transactionId: row.transactionId,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /**
   * Keyset predicate: strictly older than the cursor.
   *
   * The OR is what makes it exact when two rows share a timestamp — "older, or
   * same instant with a lower id". A plain `createdAt < cursor` would skip every
   * row that happened to land in the same millisecond as the page boundary.
   */
  private static cursorFilter(raw: string | undefined): {
    OR?: Array<{ createdAt: Date | { lt: Date }; id?: { lt: string } }>;
  } {
    if (raw === undefined) return {};
    const cursor = decodeCursor(raw);

    return {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    };
  }

  private toHistoryEntry(row: EntryRow): HistoryEntryResponse {
    const t = row.transaction;
    const entryCurrency = this.currencies.find(row.currency);
    const sourceCurrency = this.currencies.find(t.sourceCurrency);
    const destCurrency = this.currencies.find(t.destCurrency);

    if (!entryCurrency || !sourceCurrency || !destCurrency) {
      // A currency row was deleted rather than deactivated. Deactivation is the
      // supported route precisely so history stays readable.
      throw AppError.internal(
        new Error(`History references a currency missing from the table: ${row.currency}`),
      );
    }

    return {
      id: t.id,
      entryId: row.id,
      type: t.type,
      direction: row.direction,
      currency: entryCurrency.code,
      amount: MoneyUtil.toDecimalString(row.amount, entryCurrency),
      balanceAfter: MoneyUtil.toDecimalString(row.balanceAfter, entryCurrency),
      counterpartyWalletId:
        t.type === 'TRANSFER'
          ? row.direction === 'DEBIT'
            ? t.destWalletId
            : t.sourceWalletId
          : null,
      sourceCurrency: sourceCurrency.code,
      sourceAmount: MoneyUtil.toDecimalString(t.sourceAmount, sourceCurrency),
      destCurrency: destCurrency.code,
      destAmount: MoneyUtil.toDecimalString(t.destAmount, destCurrency),
      rate: MoneyUtil.rateToString(t.rateScaled),
      rateSource: t.rateSource,
      rateAsOf: t.rateAsOf.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
