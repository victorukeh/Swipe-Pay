import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AccessTokenGuard } from './auth/access-token.guard';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { NoStoreInterceptor } from './common/interceptors/no-store.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { validateEnv } from './config/env.schema';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { HistoryModule } from './history/history.module';
import { MoneyModule } from './money/money.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TransactionsModule } from './transactions/transactions.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
      /*
       * Tests take their configuration from the environment only.
       *
       * A developer's .env would otherwise leak into the suite -- which is not
       * hypothetical: it overrode the FX cache TTL so a stale rate table was
       * served instead of the seeded fixture, and every converted amount was
       * asserted against the wrong number. Worse, it could point the suite at a
       * development database.
       */
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
    }),
    PrismaModule,
    RedisModule,
    MoneyModule,
    AuthModule,
    FxModule,
    WalletsModule,
    TransactionsModule,
    HistoryModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: NoStoreInterceptor },
    // Deny by default: every route needs a valid access token unless it is
    // explicitly marked @Public(). Forgetting a decorator makes an endpoint
    // unreachable rather than silently open.
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
