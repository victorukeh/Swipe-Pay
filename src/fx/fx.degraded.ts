import type { RateSourceName } from './fx.types';

/**
 * Whether a rate source represents a degraded state.
 *
 * `live` and `cached` are both healthy: a cache hit inside its TTL is the normal
 * operating mode, not a fault, and treating it as one would mean the service
 * reported itself degraded almost all of the time -- which is the same as not
 * reporting it at all.
 *
 * `stale` and `fallback` are genuinely degraded: the provider could not be
 * reached and the number being quoted is a last-known-good snapshot or the
 * committed static table. `pegged` is a same-currency conversion, which needs no
 * provider at all.
 */
export function isDegradedSource(source: RateSourceName): boolean {
  return source === 'stale' || source === 'fallback';
}
