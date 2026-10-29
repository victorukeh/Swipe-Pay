import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * The OpenAPI document, built in one place.
 *
 * Shared by the running app (which serves it at /docs) and the generator script
 * (which writes openapi.json for the repo), so the committed spec and the live
 * UI cannot describe different APIs.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Operation Borderless')
    .setDescription(
      [
        'A cross-border stablecoin payment sandbox: multi-currency wallets, simulated deposits,',
        'cross-currency swaps, wallet-to-wallet transfers and transaction history.',
        '',
        '### Every response has the same shape',
        'Success or failure, the body is always these four keys:',
        '',
        '```json',
        '{',
        '  "requestSuccessful": true,',
        '  "requestCode": 200,',
        '  "requestMessage": "Wallets retrieved",',
        '  "requestData": {}',
        '}',
        '```',
        '',
        'Check `requestSuccessful` first. `requestCode` repeats the HTTP status so the body is',
        'self-describing, and `requestData` holds the payload — or `null` when there is nothing',
        'to return. One shape means one unwrapping path in your client.',
        '',
        '### Money is never a JSON number',
        'Every amount crosses this boundary as a **decimal string**. `JSON.parse(\'{"amount":0.1}\')`',
        'already holds an IEEE-754 double before any server code runs, so a number here would be',
        'corrupted in transit. Internally amounts are integer counts of a currency’s minor units.',
        '',
        '### Precision is per currency',
        'An amount with more decimal places than its currency admits is **rejected, not rounded**.',
        '`cXAF` has 0 decimals — the Central African CFA franc has no subunit in circulation — so',
        '`"100.50"` is not a representable amount. `GET /currencies` publishes the precision of each.',
        '',
        '### Conversions floor',
        'A converted amount is floored to the destination currency’s precision, so the system can',
        'never credit more value than it debited. A conversion that would round to zero is rejected.',
        '',
        '### Retries are safe',
        'The three money-moving endpoints require an `Idempotency-Key`. Retrying with the same key',
        'returns the original response rather than moving money twice; reusing a key with a',
        'different body is rejected. Responses carry `Idempotency-Replayed`.',
        '',
        '### Errors',
        'Failures use the same envelope, with the specifics in `requestData`:',
        '',
        '```json',
        '{',
        '  "requestSuccessful": false,',
        '  "requestCode": 422,',
        '  "requestMessage": "Insufficient funds",',
        '  "requestData": {',
        '    "errorCode": "INSUFFICIENT_FUNDS",',
        '    "details": { "currency": "USDx", "requested": "50.000000", "available": "10.000000" },',
        '    "requestId": "01a186de-eff5-7145-aec9-fef34adc48d9",',
        '    "retryable": false',
        '  }',
        '}',
        '```',
        '',
        '**Branch on `requestData.errorCode`, not on the status alone** — several distinct',
        'conditions return 422. `retryable` says whether retrying the identical request could',
        'succeed, and `requestId` is echoed as the `X-Request-Id` header so you can quote it.',
        '',
        '### Getting started',
        '1. `POST /v1/wallets` — creates a wallet and returns a token pair.',
        '2. Paste `requestData.tokens.accessToken` into **Authorize** above.',
        '3. `POST /v1/deposits`, then `/v1/swaps` or `/v1/transfers`.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'The `accessToken` from POST /v1/wallets or POST /v1/auth/tokens.',
      },
      'bearer',
    )
    .addServer('http://localhost:3000', 'Local (docker compose up)')
    .addTag('wallets', 'Create a wallet; read balances and the USD total')
    .addTag('operations', 'Deposits, swaps and transfers')
    .addTag('history', 'Transactions, a single transaction, and the attempt log')
    .addTag('rates', 'Conversion rates and supported currencies')
    .addTag('auth', 'Tokens as a resource: create, rotate, revoke')
    .addTag('health', 'Liveness, and whether rates are degraded')
    .build();

  return SwaggerModule.createDocument(app, config, { operationIdFactory: (_c, method) => method });
}
