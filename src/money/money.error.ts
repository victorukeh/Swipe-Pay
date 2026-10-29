/**
 * Money primitives throw these, not HTTP exceptions.
 *
 * Keeping `src/money` free of any framework or transport dependency is what lets
 * it be unit-tested as pure arithmetic. The global exception filter translates a
 * MoneyError into the API's error envelope.
 */
export type MoneyErrorCode =
  'INVALID_AMOUNT' | 'AMOUNT_PRECISION_EXCEEDED' | 'AMOUNT_OUT_OF_RANGE' | 'INVALID_RATE';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}
