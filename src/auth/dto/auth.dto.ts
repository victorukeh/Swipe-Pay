import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** E.164: a leading '+', a non-zero country code, 7-15 digits in total. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Credentials are accepted as an email address *or* a mobile number, as the
 * brief requires. Exactly one is required, which `class-validator` cannot
 * express across two fields, so the check lives in the service and raises
 * VALIDATION_FAILED.
 */
export class CreateWalletDto {
  @ApiPropertyOptional({
    description: 'Email address. Either this or `phone` is required. Stored lower-cased.',
    example: 'ada@example.com',
  })
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    description: 'Mobile number in E.164 format. Either this or `email` is required.',
    example: '+2348012345678',
  })
  @IsOptional()
  @IsString()
  @Matches(E164, { message: 'phone must be in E.164 format, e.g. +2348012345678' })
  phone?: string;

  @ApiProperty({
    description: 'At least 12 characters. Hashed with scrypt; never stored or logged in clear.',
    example: 'correct-horse-battery-staple',
    minLength: 12,
    maxLength: 256,
  })
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(256)
  password!: string;
}

export class LoginDto {
  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsOptional()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @IsString()
  @Matches(E164, { message: 'phone must be in E.164 format, e.g. +2348012345678' })
  phone?: string;

  @ApiProperty({ example: 'correct-horse-battery-staple' })
  @IsString()
  @MaxLength(256)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({
    description: 'The refresh token issued alongside the current access token.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @IsString()
  @MaxLength(4096)
  refreshToken!: string;
}

export class TokenPairResponse {
  @ApiProperty({
    description: 'The wallet these tokens authenticate. Needed as `toWalletId` by a sender.',
    example: '01a186d3-8580-75db-876b-edb94feb8e0c',
  })
  walletId!: string;

  @ApiProperty({ description: 'Bearer token for all authenticated endpoints.' })
  accessToken!: string;

  @ApiProperty({ description: 'Used once at POST /auth/tokens/refresh, then rotated.' })
  refreshToken!: string;

  @ApiProperty({ description: 'Access token lifetime in seconds.', example: 900 })
  expiresIn!: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;
}
