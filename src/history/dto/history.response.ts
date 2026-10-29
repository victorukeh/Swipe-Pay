import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HistoryEntryResponse {
  @ApiProperty({
    description: 'The transaction this row belongs to.',
    example: '01a186e1-3c21-7a0e-9f22-6b1d2e4a8c90',
  })
  id!: string;

  @ApiProperty({
    description:
      "The ledger entry itself. A cross-currency swap produces two rows in one wallet's " +
      'statement -- a debit in the source currency and a credit in the destination -- sharing ' +
      'one transaction id but with distinct entry ids.',
    example: '01a186e1-3c22-7f41-b8d3-9a7e5c1f2b48',
  })
  entryId!: string;

  @ApiProperty({ enum: ['DEPOSIT', 'SWAP', 'TRANSFER'], example: 'TRANSFER' })
  type!: string;

  @ApiProperty({
    description: 'DEBIT when money left this wallet, CREDIT when it arrived.',
    enum: ['DEBIT', 'CREDIT'],
    example: 'DEBIT',
  })
  direction!: string;

  @ApiProperty({ description: 'Currency of this row.', example: 'USDx' })
  currency!: string;

  @ApiProperty({ description: 'Magnitude of this row, as a decimal string.', example: '10.000000' })
  amount!: string;

  @ApiProperty({
    description: "This wallet's balance in this currency immediately after the row was applied.",
    example: '271.405660',
  })
  balanceAfter!: string;

  @ApiPropertyOptional({
    description: 'The other wallet, for a transfer. Null for deposits and swaps.',
    nullable: true,
    example: '01a186df-7c10-7bb1-9a44-2f8e1c3d5a67',
  })
  counterpartyWalletId!: string | null;

  @ApiProperty({ example: 'USDx' })
  sourceCurrency!: string;

  @ApiProperty({ example: '10.000000' })
  sourceAmount!: string;

  @ApiProperty({ example: 'EURx' })
  destCurrency!: string;

  @ApiProperty({ example: '9.185000' })
  destAmount!: string;

  @ApiProperty({ description: 'Rate applied to the whole transaction.', example: '0.9185' })
  rate!: string;

  @ApiProperty({ enum: ['LIVE', 'CACHED', 'STALE', 'FALLBACK', 'PEGGED'], example: 'LIVE' })
  rateSource!: string;

  @ApiProperty({ example: '2026-10-29T08:00:00.000Z' })
  rateAsOf!: string;

  @ApiProperty({ example: '2026-10-29T08:09:12.401Z' })
  createdAt!: string;
}

export class AttemptResponse {
  @ApiProperty({ example: '01a186e2-5f80-7b12-a3c4-7d9e1f2a3b4c' })
  id!: string;

  @ApiProperty({ enum: ['DEPOSIT', 'SWAP', 'TRANSFER'], example: 'SWAP' })
  type!: string;

  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'], example: 'FAILED' })
  outcome!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Set when the attempt succeeded.' })
  transactionId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'INSUFFICIENT_FUNDS' })
  errorCode!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Insufficient funds' })
  errorMessage!: string | null;

  @ApiProperty({
    description: 'Correlation id, matching the `requestId` the client saw in the error envelope.',
    example: '01a186de-eff5-7145-aec9-fef34adc48d9',
  })
  requestId!: string;

  @ApiProperty({ example: '2026-10-29T08:09:12.401Z' })
  createdAt!: string;
}

export class TransactionPageResponse {
  @ApiProperty({ type: [HistoryEntryResponse] })
  items!: HistoryEntryResponse[];

  @ApiPropertyOptional({
    description: 'Pass as `cursor` to fetch the next page. Null on the last page.',
    nullable: true,
  })
  nextCursor!: string | null;

  @ApiProperty({ example: true })
  hasMore!: boolean;
}

export class AttemptPageResponse {
  @ApiProperty({ type: [AttemptResponse] })
  items!: AttemptResponse[];

  @ApiPropertyOptional({ nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ example: false })
  hasMore!: boolean;
}
