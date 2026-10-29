import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * The single shape every response from this API takes, success or failure.
 *
 * A uniform envelope means a client writes one unwrapping path instead of
 * branching on whether a call succeeded before it knows where to look. The
 * trade-off is that the HTTP status is duplicated in the body -- deliberate, so
 * a client that only has the payload (a log line, a queued webhook, a mobile SDK
 * that discards the response object) can still tell what happened.
 */
export class ResponseEnvelope<T> {
  @ApiProperty({
    description: 'True for any 2xx response, false otherwise. Check this first.',
    example: true,
  })
  requestSuccessful!: boolean;

  @ApiProperty({
    description: 'The HTTP status code, repeated here so the body is self-describing.',
    example: 200,
  })
  requestCode!: number;

  @ApiProperty({
    description:
      'A human-readable summary. Safe to log; on failure it is the same message as the error, ' +
      'and for a 5xx it is deliberately generic.',
    example: 'Wallet balances retrieved',
  })
  requestMessage!: string;

  @ApiProperty({
    description:
      'The payload on success. On failure it carries the error specifics: `errorCode`, ' +
      '`details`, `requestId` and `retryable`. Null when there is nothing to return.',
  })
  requestData!: T | null;
}

/**
 * The failure payload.
 *
 * `errorCode` lives here rather than in `requestCode` because the two answer
 * different questions: the status says what kind of failure it was in HTTP
 * terms, the code says exactly which one. Several distinct conditions return
 * 422, so a client has to branch on `errorCode`.
 */
export class ErrorPayload {
  @ApiProperty({
    description: 'Stable machine-readable code. Branch on this, never on requestCode alone.',
    example: 'INSUFFICIENT_FUNDS',
  })
  errorCode!: string;

  @ApiProperty({
    description: 'Structured context for the failure. Empty for a 5xx.',
    example: { currency: 'USDx', requested: '50.000000', available: '10.000000' },
  })
  details!: Record<string, unknown>;

  @ApiProperty({
    description: 'Correlation id, also returned as the X-Request-Id header.',
    example: '01a186de-eff5-7145-aec9-fef34adc48d9',
  })
  requestId!: string;

  @ApiProperty({
    description: 'True when retrying the identical request could succeed.',
    example: false,
  })
  retryable!: boolean;
}

export function envelope<T>(params: {
  status: number;
  message: string;
  data: T | null;
}): ResponseEnvelope<T> {
  return {
    requestSuccessful: params.status >= 200 && params.status < 300,
    requestCode: params.status,
    requestMessage: params.message,
    requestData: params.data,
  };
}

/**
 * Documents a route as returning `model` inside the envelope.
 *
 * Without this the committed spec would describe the unwrapped payload and be
 * wrong about every response in the API — a spec that is quietly wrong is worse
 * than none, because a reader cannot tell.
 */
export function ApiEnvelope<T extends Type<unknown>>(
  model: T,
  options: { status?: number; description?: string; isArray?: boolean } = {},
): MethodDecorator & ClassDecorator {
  const status = options.status ?? 200;
  const payload = options.isArray
    ? { type: 'array' as const, items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };

  return applyDecorators(
    ApiExtraModels(ResponseEnvelope, model),
    ApiResponse({
      status,
      ...(options.description === undefined ? {} : { description: options.description }),
      schema: {
        allOf: [
          { $ref: getSchemaPath(ResponseEnvelope) },
          { properties: { requestData: payload }, required: ['requestData'] },
        ],
      },
    }),
  );
}

/** Documents a failure response, which always carries an ErrorPayload. */
export function ApiEnvelopeError(
  status: number,
  description: string,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(ResponseEnvelope, ErrorPayload),
    ApiResponse({
      status,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ResponseEnvelope) },
          {
            properties: { requestData: { $ref: getSchemaPath(ErrorPayload) } },
            required: ['requestData'],
          },
        ],
      },
    }),
  );
}
