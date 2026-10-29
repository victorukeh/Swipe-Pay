import { createHarness, seedTestRates, type Harness } from './app-harness';
import { createWallet, data, deposit, errorCode, swap, transfer, type Wallet } from './helpers';

interface HistoryPage {
  items: Array<{
    id: string;
    entryId: string;
    type: string;
    direction: string;
    currency: string;
    amount: string;
    balanceAfter: string;
    counterpartyWalletId: string | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}

describe('history', () => {
  let h: Harness;
  let alice: Wallet;
  let bob: Wallet;
  let carol: Wallet;
  let transferId: string;

  const page = (res: { body: unknown }): HistoryPage => data<HistoryPage>(res);

  beforeAll(async () => {
    h = await createHarness();
    await seedTestRates(h.prisma);

    alice = await createWallet(h, 'h-alice');
    bob = await createWallet(h, 'h-bob');
    carol = await createWallet(h, 'h-carol');

    // Four movements, so ordering, filtering and paging all have something to
    // bite on.
    await deposit(h, alice, 'cNGN', '16000.00');
    await swap(h, alice, 'cNGN', 'USDx', '8000.00');
    const xfer = await transfer(h, alice, bob.id, 'USDx', '2.000000', 'EURx');
    transferId = xfer['id'] as string;
    await transfer(h, alice, bob.id, 'cNGN', '500.00');
  });

  afterAll(async () => {
    await h.close();
  });

  it("lists the caller's movements newest first", async () => {
    const res = await h
      .http()
      .get('/v1/transactions')
      .set('authorization', `Bearer ${alice.accessToken}`)
      .expect(200);

    const { items } = page(res);
    // A deposit, a swap (two rows -- a debit and a credit), and two transfers.
    expect(items.map((i) => [i.type, i.direction, i.currency])).toEqual([
      ['TRANSFER', 'DEBIT', 'cNGN'],
      ['TRANSFER', 'DEBIT', 'USDx'],
      ['SWAP', 'CREDIT', 'USDx'],
      ['SWAP', 'DEBIT', 'cNGN'],
      ['DEPOSIT', 'CREDIT', 'cNGN'],
    ]);
  });

  it('shows one transfer as sent to the sender and received by the receiver', async () => {
    const sent = page(
      await h
        .http()
        .get('/v1/transactions?type=TRANSFER&currency=USDx')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .expect(200),
    );
    const received = page(
      await h
        .http()
        .get('/v1/transactions?type=TRANSFER&currency=EURx')
        .set('authorization', `Bearer ${bob.accessToken}`)
        .expect(200),
    );

    // One transaction, stored once, read correctly from both sides.
    expect(sent.items[0]?.id).toBe(transferId);
    expect(received.items[0]?.id).toBe(transferId);
    expect(sent.items[0]?.direction).toBe('DEBIT');
    expect(received.items[0]?.direction).toBe('CREDIT');
    expect(sent.items[0]?.amount).toBe('2.000000');
    expect(received.items[0]?.amount).toBe('1.600000');
    expect(sent.items[0]?.counterpartyWalletId).toBe(bob.id);
    expect(received.items[0]?.counterpartyWalletId).toBe(alice.id);
  });

  it('shows a cross-currency swap as two rows of one transaction', async () => {
    const { items } = page(
      await h
        .http()
        .get('/v1/transactions?type=SWAP')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .expect(200),
    );

    expect(items).toHaveLength(2);
    // Same transaction, distinct entries, opposite directions.
    expect(items[0]?.id).toBe(items[1]?.id);
    expect(items[0]?.entryId).not.toBe(items[1]?.entryId);
    expect(new Set(items.map((i) => i.direction))).toEqual(new Set(['DEBIT', 'CREDIT']));
  });

  it('carries the running balance on each row', async () => {
    const { items } = page(
      await h
        .http()
        .get('/v1/transactions?currency=cNGN&direction=CREDIT')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .expect(200),
    );
    expect(items[0]?.balanceAfter).toBe('16000.00');
  });

  it.each([
    ['type=DEPOSIT', 'type=DEPOSIT', 1],
    ['type=TRANSFER', 'type=TRANSFER', 2],
    ['currency=USDx', 'currency=USDx', 2],
    ['currency=EURx for the sender', 'currency=EURx', 0],
    ['direction=CREDIT', 'direction=CREDIT', 2],
    ['type and currency together', 'type=SWAP&currency=cNGN', 1],
  ])('filters by %s', async (_label, query, expected) => {
    const { items } = page(
      await h
        .http()
        .get(`/v1/transactions?${query}`)
        .set('authorization', `Bearer ${alice.accessToken}`)
        .expect(200),
    );
    expect(items).toHaveLength(expected);
  });

  it('pages through the whole statement with no gap or overlap', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const url = `/v1/transactions?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const body = page(
        await h.http().get(url).set('authorization', `Bearer ${alice.accessToken}`).expect(200),
      );
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((i) => i.entryId));
      cursor = body.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 10);

    // Five entries across three pages, each exactly once.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a malformed cursor rather than ignoring it', async () => {
    const res = await h
      .http()
      .get('/v1/transactions?cursor=!!!not-base64!!!')
      .set('authorization', `Bearer ${alice.accessToken}`)
      .expect(400);
    expect(errorCode(res.body)).toBe('INVALID_CURSOR');
  });

  it.each([
    ['an unknown currency', 'currency=cFAKE', 422, 'UNSUPPORTED_CURRENCY'],
    ['an invalid type', 'type=NONSENSE', 400, 'VALIDATION_FAILED'],
    ['an out-of-range limit', 'limit=5000', 400, 'VALIDATION_FAILED'],
  ])('rejects %s', async (_label, query, status, code) => {
    const res = await h
      .http()
      .get(`/v1/transactions?${query}`)
      .set('authorization', `Bearer ${alice.accessToken}`)
      .expect(status);
    expect(errorCode(res.body)).toBe(code);
  });

  describe('fetch by id', () => {
    it('is readable by the sender', async () => {
      const res = await h
        .http()
        .get(`/v1/transactions/${transferId}`)
        .set('authorization', `Bearer ${alice.accessToken}`)
        .expect(200);
      expect(data<{ direction: string }>(res).direction).toBe('DEBIT');
    });

    it('is readable by the receiver', async () => {
      const res = await h
        .http()
        .get(`/v1/transactions/${transferId}`)
        .set('authorization', `Bearer ${bob.accessToken}`)
        .expect(200);
      expect(data<{ direction: string }>(res).direction).toBe('CREDIT');
    });

    it('is not readable by anyone else', async () => {
      // The IDOR case: authenticated, but party to neither side.
      const res = await h
        .http()
        .get(`/v1/transactions/${transferId}`)
        .set('authorization', `Bearer ${carol.accessToken}`)
        .expect(403);
      expect(errorCode(res.body)).toBe('FORBIDDEN_WALLET_ACCESS');
    });

    it('404s for an id that does not exist', async () => {
      const res = await h
        .http()
        .get('/v1/transactions/01a186e6-0000-7000-8000-000000000000')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .expect(404);
      expect(errorCode(res.body)).toBe('TRANSACTION_NOT_FOUND');
    });

    it('400s for an id that is not a UUID', async () => {
      await h
        .http()
        .get('/v1/transactions/not-a-uuid')
        .set('authorization', `Bearer ${alice.accessToken}`)
        .expect(400);
    });

    it('requires authentication', async () => {
      await h.http().get(`/v1/transactions/${transferId}`).expect(401);
    });
  });

  describe('attempt log', () => {
    it('records successes and failures, and filters by outcome', async () => {
      const wallet = await createWallet(h, 'h-att');
      await deposit(h, wallet, 'cNGN', '10.00');
      await h
        .http()
        .post('/v1/swaps')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', 'h-att-fail')
        .send({ fromCurrency: 'cNGN', toCurrency: 'USDx', amount: '9999.00' })
        .expect(422);

      const all = page(
        await h
          .http()
          .get('/v1/attempts')
          .set('authorization', `Bearer ${wallet.accessToken}`)
          .expect(200),
      );
      expect(all.items).toHaveLength(2);

      const failed = data<{ items: Array<{ errorCode: string; requestId: string }> }>(
        await h
          .http()
          .get('/v1/attempts?outcome=FAILED')
          .set('authorization', `Bearer ${wallet.accessToken}`)
          .expect(200),
      );

      expect(failed.items).toHaveLength(1);
      expect(failed.items[0]?.errorCode).toBe('INSUFFICIENT_FUNDS');
      // The request id is what ties a client's error report to this row.
      expect(failed.items[0]?.requestId).toMatch(/.+/);
    });

    it("only shows the caller's own attempts", async () => {
      const mine = page(
        await h
          .http()
          .get('/v1/attempts')
          .set('authorization', `Bearer ${carol.accessToken}`)
          .expect(200),
      );
      expect(mine.items).toHaveLength(0);
    });
  });
});
