import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AccessTokenGuard } from './access-token.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RedisTokenStore } from './redis-token.store';
import { TOKEN_STORE } from './token.store';

/**
 * Global because the access-token guard is registered app-wide and needs
 * AuthService wherever it runs.
 *
 * TOKEN_STORE is bound to RedisTokenStore here and nowhere else, so nothing
 * outside this module knows the store is Redis.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    AccessTokenGuard,
    { provide: TOKEN_STORE, useClass: RedisTokenStore },
  ],
  exports: [AuthService, PasswordService, AccessTokenGuard],
})
export class AuthModule {}
