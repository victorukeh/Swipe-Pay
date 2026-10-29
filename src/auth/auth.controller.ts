import { Body, Controller, Delete, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiEnvelope, ApiEnvelopeError } from '../common/http/response-envelope';
import { ResponseMessage } from '../common/interceptors/response-envelope.interceptor';

import type { AuthenticatedWallet } from '../common/request-context';
import { AuthService } from './auth.service';
import { CurrentWallet } from './current-wallet.decorator';
import { LoginDto, RefreshDto, TokenPairResponse } from './dto/auth.dto';
import { Public } from './public.decorator';

@ApiTags('auth')
@Controller('auth/tokens')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Log in: exchange credentials for a token pair',
    description:
      'Identify the wallet by the email or phone it was created with. A failed login does not ' +
      'reveal whether the contact exists, so this endpoint cannot be used to enumerate wallets.',
  })
  @ApiEnvelope(TokenPairResponse, { status: 201 })
  @ApiEnvelopeError(401, 'INVALID_CREDENTIALS')
  @ResponseMessage('Signed in')
  async login(@Body() dto: LoginDto): Promise<TokenPairResponse> {
    return this.auth.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Rotate a refresh token for a new pair',
    description:
      'The presented refresh token is revoked as the new pair is issued, so a captured refresh ' +
      'token is usable at most once. Replaying one returns TOKEN_REVOKED.',
  })
  @ApiEnvelope(TokenPairResponse, { status: 201 })
  @ApiEnvelopeError(401, 'TOKEN_REVOKED, TOKEN_EXPIRED or TOKEN_WRONG_TYPE')
  @ResponseMessage('Tokens rotated')
  async refresh(@Body() dto: RefreshDto): Promise<TokenPairResponse> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Delete()
  // 200 rather than 204: every response carries the envelope, and a 204 has no
  // body to put it in.
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Log out: revoke the presented access token, and a refresh token if supplied',
    description:
      'The access token is denylisted in Redis for its remaining lifetime, which is the only way ' +
      'a self-contained JWT can be invalidated before it expires.',
  })
  @ApiEnvelopeError(401, 'UNAUTHENTICATED or TOKEN_REVOKED')
  @ResponseMessage('Signed out')
  async logout(
    @CurrentWallet() wallet: AuthenticatedWallet,
    @Body() dto: Partial<RefreshDto>,
  ): Promise<void> {
    await this.auth.logout({
      accessJti: wallet.jti,
      accessExpiresAt: wallet.expiresAt,
      walletId: wallet.walletId,
      refreshToken: dto.refreshToken,
    });
  }
}
