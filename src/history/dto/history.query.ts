import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const TRANSACTION_TYPES = ['DEPOSIT', 'SWAP', 'TRANSFER'] as const;
export const DIRECTIONS = ['DEBIT', 'CREDIT'] as const;

export class TransactionHistoryQuery {
  @ApiPropertyOptional({
    description: 'Only movements of this kind.',
    enum: TRANSACTION_TYPES,
    example: 'TRANSFER',
  })
  @IsOptional()
  @IsIn(TRANSACTION_TYPES)
  type?: (typeof TRANSACTION_TYPES)[number];

  @ApiPropertyOptional({
    description:
      'Only movements that touched this currency for the caller. A cNGN to USDx swap matches ' +
      'both `cNGN` and `USDx`, because the wallet has a ledger entry in each.',
    example: 'USDx',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  currency?: string;

  @ApiPropertyOptional({
    description: 'DEBIT for money that left the wallet, CREDIT for money that arrived.',
    enum: DIRECTIONS,
    example: 'DEBIT',
  })
  @IsOptional()
  @IsIn(DIRECTIONS)
  direction?: (typeof DIRECTIONS)[number];

  @ApiPropertyOptional({
    description: 'Page size, 1-100.',
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description:
      "Opaque cursor from the previous page's `nextCursor`. Cursor paging rather than an offset " +
      'because new movements arrive at the top of this list constantly: with OFFSET, a deposit ' +
      'landing between two page requests silently shifts every later row and the client both ' +
      'misses and repeats entries.',
    example: 'MDFhMTg2ZTEtM2MyMS03YTBlLTlmMjItNmIxZDJlNGE4Yzkw',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;
}

export class AttemptHistoryQuery {
  @ApiPropertyOptional({ enum: ['SUCCEEDED', 'FAILED'], example: 'FAILED' })
  @IsOptional()
  @IsIn(['SUCCEEDED', 'FAILED'] as const)
  outcome?: 'SUCCEEDED' | 'FAILED';

  @ApiPropertyOptional({ enum: TRANSACTION_TYPES, example: 'SWAP' })
  @IsOptional()
  @IsIn(TRANSACTION_TYPES)
  type?: (typeof TRANSACTION_TYPES)[number];

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;
}
