import { createHash } from 'node:crypto';

/**
 * A stable fingerprint of a request body.
 *
 * Keys are sorted recursively so `{a:1,b:2}` and `{b:2,a:1}` hash identically —
 * a client that serialises its JSON in a different order on retry is sending the
 * same request, and must get a replay rather than IDEMPOTENCY_KEY_REUSED.
 *
 * Only the hash is stored, never the body: it is enough to prove two attempts
 * were the same request, without keeping the request itself around.
 */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // An absent field and an explicitly-null one are the same request as far
      // as these endpoints are concerned, so undefined is dropped.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalise(v)]));
  }

  // BigInt has no JSON form; amounts arrive as strings anyway, so this is only
  // defensive.
  if (typeof value === 'bigint') return value.toString();

  return value;
}

export function hashRequest(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalise(body)))
    .digest('hex');
}
