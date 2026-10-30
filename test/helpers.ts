import type { Harness } from './app-harness';
import { uniqueEmail, uniqueKey } from './app-harness';

/**
 * Unwraps the standard response envelope.
 *
 * Every response from the API is
 * `{ requestSuccessful, requestCode, requestMessage, requestData }`, so the
 * suite reaches through it here rather than in every assertion.
 */
export function data<T>(res: { body: unknown }): T {
  const body = res.body as { requestData?: unknown };
  return body.requestData as T;
}

/** The whole envelope, for the tests that assert on its shape. */
export function wrapper(res: { body: unknown }): {
  requestSuccessful: boolean;
  requestCode: number;
  requestMessage: string;
  requestData: unknown;
} {
  return res.body as {
    requestSuccessful: boolean;
    requestCode: number;
    requestMessage: string;
    requestData: unknown;
  };
}

export interface Wallet {
  id: string;
  accessToken: string;
  refreshToken: string;
  email: string;
}

/**
 * Registers a wallet, then logs in to get its tokens.
 *
 * Two round trips, deliberately: registration (`POST /auth/register`) no
 * longer returns a token pair, so this helper does what any real client must
 * do -- register, then authenticate separately at `POST /auth/tokens`.
 */
export async function createWallet(h: Harness, prefix = 'w'): Promise<Wallet> {
  const email = uniqueEmail(prefix);
  const password = 'correct-horse-battery-staple';

  const registerRes = await h.http().post('/v1/auth/register').send({ email, password }).expect(201);
  const wallet = data<{ id: string }>(registerRes);

  const loginRes = await h.http().post('/v1/auth/tokens').send({ email, password }).expect(201);
  const tokens = data<{ accessToken: string; refreshToken: string }>(loginRes);

  return {
    id: wallet.id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    email,
  };
}

export async function deposit(
  h: Harness,
  wallet: Wallet,
  currency: string,
  amount: string,
): Promise<Record<string, unknown>> {
  const res = await h
    .http()
    .post('/v1/deposits')
    .set('authorization', `Bearer ${wallet.accessToken}`)
    .set('idempotency-key', uniqueKey('dep'))
    .send({ currency, amount })
    .expect(201);
  return data<Record<string, unknown>>(res);
}

export async function swap(
  h: Harness,
  wallet: Wallet,
  fromCurrency: string,
  toCurrency: string,
  amount: string,
): Promise<Record<string, unknown>> {
  const res = await h
    .http()
    .post('/v1/swaps')
    .set('authorization', `Bearer ${wallet.accessToken}`)
    .set('idempotency-key', uniqueKey('swap'))
    .send({ fromCurrency, toCurrency, amount })
    .expect(201);
  return data<Record<string, unknown>>(res);
}

export async function transfer(
  h: Harness,
  from: Wallet,
  toWalletId: string,
  currency: string,
  amount: string,
  toCurrency?: string,
): Promise<Record<string, unknown>> {
  const res = await h
    .http()
    .post('/v1/transfers')
    .set('authorization', `Bearer ${from.accessToken}`)
    .set('idempotency-key', uniqueKey('xfer'))
    .send({ toWalletId, currency, amount, ...(toCurrency === undefined ? {} : { toCurrency }) })
    .expect(201);
  return data<Record<string, unknown>>(res);
}

export interface BalanceMap {
  [currency: string]: string;
}

export async function balances(h: Harness, wallet: Wallet): Promise<BalanceMap> {
  const res = await h
    .http()
    .get('/v1/wallets')
    .set('authorization', `Bearer ${wallet.accessToken}`)
    .expect(200);

  const body = data<Array<{ balances: Array<{ currency: string; amount: string }> }>>(res);
  const out: BalanceMap = {};
  for (const entry of body[0]?.balances ?? []) out[entry.currency] = entry.amount;
  return out;
}

export async function walletTotal(h: Harness, wallet: Wallet): Promise<string> {
  const res = await h
    .http()
    .get('/v1/wallets')
    .set('authorization', `Bearer ${wallet.accessToken}`)
    .expect(200);
  return data<Array<{ totalUsdEquivalent: string }>>(res)[0]?.totalUsdEquivalent ?? '';
}

/**
 * The error code from a failed response.
 *
 * It lives in `requestData.errorCode` rather than at the top level, because
 * `requestCode` is the HTTP status and the two answer different questions:
 * several distinct conditions return 422.
 */
export function errorCode(body: unknown): string {
  return (body as { requestData?: { errorCode?: string } }).requestData?.errorCode ?? '';
}

export function errorDetails(body: unknown): Record<string, unknown> {
  return (
    (body as { requestData?: { details?: Record<string, unknown> } }).requestData?.details ?? {}
  );
}

export function errorRetryable(body: unknown): boolean {
  return (body as { requestData?: { retryable?: boolean } }).requestData?.retryable ?? false;
}
