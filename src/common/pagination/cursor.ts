import { AppError } from '../errors/app-error';

/**
 * Keyset pagination over a newest-first list.
 *
 * The cursor is the (createdAt, id) of the last row returned, base64-encoded so
 * clients treat it as opaque and we stay free to change what is in it.
 *
 * Offset paging would be wrong here, not merely slower. Money arrives at the top
 * of this list continuously, so with OFFSET a deposit landing between two page
 * requests shifts every later row down: the client both misses entries and sees
 * others twice. A keyset cursor describes a position in the data rather than a
 * count of rows skipped, so the page boundary stays stable no matter what is
 * written while the client reads.
 *
 * `id` breaks ties, because UUIDv7 is time-ordered and two movements can land in
 * the same millisecond — without it, a page boundary falling between two rows
 * with the same timestamp would drop or repeat one.
 */
export interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw AppError.invalidCursor();
  }

  const separator = decoded.lastIndexOf('|');
  if (separator === -1) throw AppError.invalidCursor();

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime()) || id === '') throw AppError.invalidCursor();

  return { createdAt, id };
}

export interface Page<T> {
  readonly items: T[];
  /** Pass as `cursor` for the next page. Null when this is the last page. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Trims an over-fetched result set into a page.
 *
 * Callers ask for `limit + 1` rows; the extra row is never returned, it only
 * proves another page exists. That avoids a second COUNT query, which on a
 * growing ledger would be the expensive part of the request.
 */
export function toPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    hasMore,
  };
}
