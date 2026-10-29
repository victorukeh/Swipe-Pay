/**
 * Shapes the money layer exposes. No logic lives here, so anything may import
 * it without pulling in the arithmetic.
 */

/** The result of `MoneyUtil.convert`, including the dust it had to discard. */
export interface ConversionResult {
  /** The converted amount in destination minor units, floored. */
  readonly amount: bigint;
  /** Discarded numerator; `remainder / denominator` destination minor units. */
  readonly remainder: bigint;
  readonly denominator: bigint;
  /** True when the conversion was exactly representable. */
  readonly exact: boolean;
}
