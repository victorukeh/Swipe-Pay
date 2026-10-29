import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * An unsigned decimal string — not a number.
 *
 * `JSON.parse('{"amount":0.1}')` already contains a float before any of our code
 * runs, so amounts never cross this boundary as JSON numbers. The pattern is
 * enforced here and the precision is checked against the currency's own scale by
 * MoneyUtil, which rejects "0.005 cNGN" rather than rounding it.
 */
const DECIMAL = /^\d+(\.\d+)?$/;

const AMOUNT_DOC = {
  description:
    'Amount as an unsigned decimal string, at most as precise as the currency allows. ' +
    'A string rather than a number so no floating-point rounding can occur in transit.',
  example: '1500.00',
} as const;

export class DepositDto {
  @ApiProperty({ description: 'Currency to credit. See GET /currencies.', example: 'cNGN' })
  @IsString()
  @MaxLength(16)
  currency!: string;

  @ApiProperty(AMOUNT_DOC)
  @IsString()
  @MaxLength(40)
  @Matches(DECIMAL, { message: 'amount must be an unsigned decimal string, e.g. "1500.00"' })
  amount!: string;
}

export class SwapDto {
  @ApiProperty({ description: 'Currency to debit.', example: 'cNGN' })
  @IsString()
  @MaxLength(16)
  fromCurrency!: string;

  @ApiProperty({
    description: 'Currency to credit. Must differ from fromCurrency.',
    example: 'USDx',
  })
  @IsString()
  @MaxLength(16)
  toCurrency!: string;

  @ApiProperty({
    ...AMOUNT_DOC,
    description: `${AMOUNT_DOC.description} Denominated in fromCurrency.`,
  })
  @IsString()
  @MaxLength(40)
  @Matches(DECIMAL, { message: 'amount must be an unsigned decimal string, e.g. "1500.00"' })
  amount!: string;
}

export class TransferDto {
  @ApiProperty({
    description:
      'The receiving wallet. The sender is always the token holder, so there is no fromWalletId.',
    example: '01a186de-ebf2-776d-855a-171636dc7355',
  })
  @IsUUID()
  toWalletId!: string;

  @ApiProperty({ description: 'Currency to debit from the sender.', example: 'USDx' })
  @IsString()
  @MaxLength(16)
  currency!: string;

  @ApiPropertyOptional({
    description:
      'Currency to credit to the receiver. Defaults to `currency`. When they differ the amount ' +
      'is converted at the current rate and both legs are recorded.',
    example: 'EURx',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  toCurrency?: string;

  @ApiProperty({ ...AMOUNT_DOC, description: `${AMOUNT_DOC.description} Denominated in currency.` })
  @IsString()
  @MaxLength(40)
  @Matches(DECIMAL, { message: 'amount must be an unsigned decimal string, e.g. "1500.00"' })
  amount!: string;
}
