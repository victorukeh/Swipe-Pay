import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * The OpenAPI document, built in one place.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Operation Borderless')
    .setDescription(
      [
        'A cross-border stablecoin payment sandbox: multi-currency wallets, simulated deposits,',
        'cross-currency swaps, wallet-to-wallet transfers and transaction history.',
        '',
        '### Getting started',
        '1. `POST /v1/auth/register` — registers a wallet by email or phone + password.',
        '2. `POST /v1/auth/tokens` — log in with the same credentials for a token pair.',
        '3. Paste `requestData.accessToken` into **Authorize** above.',
        '4. `POST /v1/deposits`, then `/v1/swaps` or `/v1/transfers`.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'The `accessToken` from POST /v1/auth/tokens.',
      },
      'bearer',
    )
    .addServer('http://localhost:3000', 'Local (docker compose up)')
    .addTag('wallets', 'Read balances and the USD total')
    .addTag('operations', 'Deposits, swaps and transfers')
    .addTag('history', 'Transactions, a single transaction, and the attempt log')
    .addTag('rates', 'Conversion rates and supported currencies')
    .addTag('auth', 'Register, then tokens as a resource: create, rotate, revoke')
    .addTag('health', 'Liveness, and whether rates are degraded')
    .build();

  return SwaggerModule.createDocument(app, config, { operationIdFactory: (_c, method) => method });
}
