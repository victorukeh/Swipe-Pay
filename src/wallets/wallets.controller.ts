import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiEnvelope, ApiEnvelopeError } from '../common/http/response-envelope';
import { ResponseMessage } from '../common/interceptors/response-envelope.interceptor';

import { CurrentWallet } from '../auth/current-wallet.decorator';
import { CreateWalletDto } from '../auth/dto/auth.dto';
import { Public } from '../auth/public.decorator';
import type { AuthenticatedWallet } from '../common/request-context';
import { CreateWalletResponse, WalletResponse } from './dto/wallet.response';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a wallet',
    description:
      'Identified by an email address or a mobile number -- exactly one is required, and neither ' +
      'may already belong to another wallet. The wallet holds a balance in every supported ' +
      'currency. Returns a token pair, so creating and first using a wallet is one round trip.',
  })
  @ApiEnvelope(CreateWalletResponse, { status: 201 })
  @ApiEnvelopeError(409, 'WALLET_CONTACT_TAKEN -- that email or phone already has a wallet.')
  @ResponseMessage('Wallet created')
  async create(@Body() dto: CreateWalletDto): Promise<CreateWalletResponse> {
    return this.wallets.create(dto);
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The caller's wallets",
    description:
      'Resolved from the access token: there is no wallet id in the path, so no caller can read ' +
      'another wallet. An admin view of every wallet would live at GET /wallets/all.',
  })
  @ApiEnvelope(WalletResponse, { isArray: true })
  @ResponseMessage('Wallets retrieved')
  async list(@CurrentWallet() wallet: AuthenticatedWallet): Promise<WalletResponse[]> {
    return this.wallets.list(wallet.walletId);
  }
}
