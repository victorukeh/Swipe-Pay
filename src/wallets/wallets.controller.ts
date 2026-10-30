import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiEnvelope } from '../common/http/response-envelope';
import { ResponseMessage } from '../common/interceptors/response-envelope.interceptor';

import { CurrentWallet } from '../auth/current-wallet.decorator';
import type { AuthenticatedWallet } from '../common/request-context';
import { WalletResponse } from './dto/wallet.response';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

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
