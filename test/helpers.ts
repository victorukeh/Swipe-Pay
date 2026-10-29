import type { Harness } from './app-harness';
import { uniqueEmail, uniqueKey } from './app-harness';

export interface Wallet {
  id: string;
  accessToken: string;
  refreshToken: string;
  email: string;
}

/** Creates a wallet and returns it with its tokens. */
export async function createWallet(h: Harness, prefix = 'w'): Promise<Wallet> {
  const email = uniqueEmail(prefix);
  const res = await h
    .http()
    .post('/v1/wallets')
    .send({ email, password: 'correct-horse-battery-staple' })
    .expect(201);

  const body = res.body as {
    id: string;
    tokens: { accessToken: string; refreshToken: string };
  };
  return {
    id: body.id,
    accessToken: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
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
  return res.body as Record<string, unknown>;
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
  return res.body as Record<string, unknown>;
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
  return res.body as Record<string, unknown>;
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

  const body = res.body as Array<{ balances: Array<{ currency: string; amount: string }> }>;
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
  return (res.body as Array<{ totalUsdEquivalent: string }>)[0]?.totalUsdEquivalent ?? '';
}

/** The error code from a failed response, for concise assertions. */
export function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? '';
}

export function errorDetails(body: unknown): Record<string, unknown> {
  return (body as { error?: { details?: Record<string, unknown> } }).error?.details ?? {};
}
