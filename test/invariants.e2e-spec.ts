import { createHarness, seedTestRates, uniqueKey, type Harness } from './app-harness';
import { balances, createWallet, deposit, errorCode, transfer } from './helpers';

/**
 * The properties that have to hold no matter what the API is asked to do.
 *
 * These are the tests that justify the design: the row locking, the clearing
 * accounts, and keeping failures out of the `transactions` table all exist to
 * make these assertions true, and none of them could be checked against an
 * in-memory double.
 */
describe('ledger invariants', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await seedTestRates(h.prisma);
  });

  afterAll(async () => {
    await h.close();
  });

  /** The signed sum of every ledger entry, per currency. */
  async function netByCurrency(): Promise<Map<string, bigint>> {
    const entries = await h.prisma.ledgerEntry.findMany({
      select: { currency: true, direction: true, amount: true },
    });
    const net = new Map<string, bigint>();
    for (const e of entries) {
      const delta = e.direction === 'DEBIT' ? -e.amount : e.amount;
      net.set(e.currency, (net.get(e.currency) ?? 0n) + delta);
    }
    return net;
  }

  /** Balance rows that disagree with the sum of their own ledger entries. */
  async function balanceDrift(): Promise<Array<{ walletId: string; currency: string }>> {
    return h.prisma.$queryRaw<Array<{ walletId: string; currency: string }>>`
      SELECT b."wallet_id" AS "walletId", b."currency"
      FROM "balances" b
      LEFT JOIN (
        SELECT "wallet_id", "currency",
               SUM(CASE "direction" WHEN 'DEBIT' THEN -"amount" ELSE "amount" END) AS total
        FROM "ledger_entries" GROUP BY "wallet_id", "currency"
      ) e ON e."wallet_id" = b."wallet_id" AND e."currency" = b."currency"
      WHERE b."amount" <> COALESCE(e.total, 0)
    `;
  }

  it('nets to exactly zero in every currency', async () => {
    const wallet = await createWallet(h, 'inv');
    const other = await createWallet(h, 'inv2');

    // A deposit, a cross-currency swap and a cross-currency transfer between
    // them -- the three shapes a movement can take.
    await deposit(h, wallet, 'cNGN', '16000.00');
    await h
      .http()
      .post('/v1/swaps')
      .set('authorization', `Bearer ${wallet.accessToken}`)
      .set('idempotency-key', uniqueKey('inv-swap'))
      .send({ fromCurrency: 'cNGN', toCurrency: 'USDx', amount: '8000.00' })
      .expect(201);
    await transfer(h, wallet, other.id, 'USDx', '2.000000', 'EURx');

    for (const [currency, net] of await netByCurrency()) {
      // A debit in cNGN cannot net against a credit in USDx, which is exactly
      // why conversions route their counter-legs through SYSTEM_FX.
      expect({ currency, net: net.toString() }).toEqual({ currency, net: '0' });
    }
  });

  it('keeps every balance equal to the sum of its ledger entries', async () => {
    expect(await balanceDrift()).toEqual([]);
  });

  it('never lets a customer balance go negative', async () => {
    const negative = await h.prisma.balance.findMany({
      where: { amount: { lt: 0n }, allowNegative: false },
    });
    expect(negative).toEqual([]);
  });

  describe('concurrency', () => {
    it('cannot be made to overdraw by concurrent swaps', async () => {
      const wallet = await createWallet(h, 'race');
      await deposit(h, wallet, 'cNGN', '100.00');

      // Twenty requests, each for a tenth of the balance. Without the row lock
      // these would all read 100.00 and all succeed.
      const attempts = Array.from({ length: 20 }, (_, i) =>
        h
          .http()
          .post('/v1/swaps')
          .set('authorization', `Bearer ${wallet.accessToken}`)
          .set('idempotency-key', uniqueKey(`race-${i}`))
          .send({ fromCurrency: 'cNGN', toCurrency: 'cXAF', amount: '10.00' }),
      );

      const results = await Promise.all(attempts);
      const created = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 422);

      expect(created).toHaveLength(10);
      expect(rejected).toHaveLength(10);
      for (const r of rejected) expect(errorCode(r.body)).toBe('INSUFFICIENT_FUNDS');

      // Landed exactly on zero, never below it.
      expect((await balances(h, wallet))['cNGN']).toBe('0.00');
      expect(await balanceDrift()).toEqual([]);
    });

    it('does not deadlock when two wallets pay each other at once', async () => {
      const a = await createWallet(h, 'dl-a');
      const b = await createWallet(h, 'dl-b');
      await deposit(h, a, 'cNGN', '1000.00');
      await deposit(h, b, 'cNGN', '1000.00');

      // Opposing transfers touch the same two balance rows in opposite logical
      // order. Locking them in a fixed (wallet_id, currency) order is what stops
      // this pair from deadlocking.
      const results = await Promise.all([
        ...Array.from({ length: 8 }, (_, i) =>
          h
            .http()
            .post('/v1/transfers')
            .set('authorization', `Bearer ${a.accessToken}`)
            .set('idempotency-key', uniqueKey(`ab-${i}`))
            .send({ toWalletId: b.id, currency: 'cNGN', amount: '10.00' }),
        ),
        ...Array.from({ length: 8 }, (_, i) =>
          h
            .http()
            .post('/v1/transfers')
            .set('authorization', `Bearer ${b.accessToken}`)
            .set('idempotency-key', uniqueKey(`ba-${i}`))
            .send({ toWalletId: a.id, currency: 'cNGN', amount: '10.00' }),
        ),
      ]);

      // No 500s: a deadlock would surface as one.
      for (const r of results) expect(r.status).toBe(201);

      // Value is conserved: equal flows both ways leave both where they started.
      expect((await balances(h, a))['cNGN']).toBe('1000.00');
      expect((await balances(h, b))['cNGN']).toBe('1000.00');
      expect(await balanceDrift()).toEqual([]);
    });

    it('creates exactly one transaction when the same key is sent concurrently', async () => {
      const wallet = await createWallet(h, 'dup');
      const key = uniqueKey('concurrent');

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          h
            .http()
            .post('/v1/deposits')
            .set('authorization', `Bearer ${wallet.accessToken}`)
            .set('idempotency-key', key)
            .send({ currency: 'cNGN', amount: '25.00' }),
        ),
      );

      const created = results.filter((r) => r.status === 201);
      const conflicted = results.filter((r) => r.status === 409);

      // Every 201 is either the original or a replay of it, so they all name the
      // same transaction; anything in flight gets a 409 rather than a second
      // credit.
      const ids = new Set(created.map((r) => (r.body as { id: string }).id));
      expect(ids.size).toBe(1);
      for (const r of conflicted) expect(errorCode(r.body)).toBe('IDEMPOTENCY_KEY_IN_FLIGHT');

      // The decisive assertion: credited once, whatever the interleaving.
      expect((await balances(h, wallet))['cNGN']).toBe('25.00');
      expect(await h.prisma.transaction.count({ where: { sourceWalletId: wallet.id } })).toBe(1);
    });
  });

  /**
   * The projection is maintained by the database, not by the application.
   *
   * These tests exist because the alternative design -- the application writing
   * both the entry and the balance -- kept the balance in two places that had to
   * agree by convention. An `UPDATE balances SET amount = ...` could set any
   * value and leave nothing behind to say so. Now the only write the application
   * can make is an append, and the balance follows from it.
   *
   * What this does not claim: it is not a defence against someone holding owner
   * rights on the database, who can disable a trigger. It removes a class of
   * application bug, blocks injected DML, and makes tampering evident.
   */
  describe('balances are derived, not set', () => {
    it('refuses a direct change to a balance amount', async () => {
      const wallet = await createWallet(h, 'derived');
      await deposit(h, wallet, 'cNGN', '100.00');

      await expect(
        h.prisma.$executeRaw`
          UPDATE "balances" SET "amount" = 999999999
          WHERE "wallet_id" = ${wallet.id}::uuid AND "currency" = 'cNGN'
        `,
      ).rejects.toThrow(/derived from ledger_entries/);

      expect((await balances(h, wallet))['cNGN']).toBe('100.00');
    });

    it('refuses to amend or delete a ledger entry', async () => {
      const wallet = await createWallet(h, 'append-only');
      await deposit(h, wallet, 'cNGN', '100.00');

      // A correction is a compensating entry, which is an append like any other.
      await expect(
        h.prisma.$executeRaw`
          UPDATE "ledger_entries" SET "amount" = 1 WHERE "wallet_id" = ${wallet.id}::uuid
        `,
      ).rejects.toThrow(/append-only/);

      await expect(
        h.prisma.$executeRaw`DELETE FROM "ledger_entries" WHERE "wallet_id" = ${wallet.id}::uuid`,
      ).rejects.toThrow(/append-only/);
    });

    it('refuses a new balance row that already holds money', async () => {
      const wallet = await createWallet(h, 'nonzero');

      // Otherwise a wallet could start with a balance no entry accounts for,
      // breaking the invariant from its very first row.
      await expect(
        h.prisma.$executeRaw`
          INSERT INTO "balances" ("wallet_id", "currency", "amount", "allow_negative", "updated_at")
          VALUES (${wallet.id}::uuid, 'cGHS', 50000, false, now())
        `,
      ).rejects.toThrow(/must start at 0/);
    });

    it('writes balance_after from the balance it computed, not from the caller', async () => {
      const wallet = await createWallet(h, 'after');
      await deposit(h, wallet, 'cNGN', '40.00');
      await deposit(h, wallet, 'cNGN', '2.50');

      const entries = await h.prisma.ledgerEntry.findMany({
        where: { walletId: wallet.id, currency: 'cNGN' },
        orderBy: { createdAt: 'asc' },
      });

      // The running balance is the database's own arithmetic, so it cannot
      // disagree with the balance it claims to describe.
      expect(entries.map((e) => e.balanceAfter)).toEqual([4000n, 4250n]);
      const row = await h.prisma.balance.findUniqueOrThrow({
        where: { walletId_currency: { walletId: wallet.id, currency: 'cNGN' } },
      });
      expect(row.amount).toBe(4250n);
    });

    it('moves money only as a consequence of an append', async () => {
      const wallet = await createWallet(h, 'append-moves');
      await deposit(h, wallet, 'cNGN', '10.00');
      const txn = await h.prisma.transaction.findFirstOrThrow({
        where: { sourceWalletId: wallet.id },
      });

      // Appending directly is possible -- it is the one write that is allowed --
      // and the balance follows automatically. That is the point: a fraudulent
      // movement has to leave a timestamped row behind, where the net-zero check
      // will find it, rather than being an invisible edit.
      await h.prisma.$executeRaw`
        INSERT INTO "ledger_entries"
          ("id", "transaction_id", "wallet_id", "currency", "direction", "amount", "created_at")
        VALUES (gen_random_uuid(), ${txn.id}::uuid, ${wallet.id}::uuid, 'cNGN', 'CREDIT', 2500, now())
      `;

      expect((await balances(h, wallet))['cNGN']).toBe('35.00');

      const net = await netByCurrency();
      // And the books no longer balance, which is exactly how it gets caught.
      expect(net.get('cNGN')).not.toBe(0n);

      // Undo it the only legitimate way -- a compensating entry -- so the rest
      // of the suite's invariant checks still hold.
      await h.prisma.$executeRaw`
        INSERT INTO "ledger_entries"
          ("id", "transaction_id", "wallet_id", "currency", "direction", "amount", "created_at")
        VALUES (gen_random_uuid(), ${txn.id}::uuid, ${wallet.id}::uuid, 'cNGN', 'DEBIT', 2500, now())
      `;
      expect((await balances(h, wallet))['cNGN']).toBe('10.00');
    });
  });

  describe('failed operations', () => {
    it('writes no ledger entry but does record the attempt', async () => {
      const wallet = await createWallet(h, 'failed');
      await deposit(h, wallet, 'cNGN', '5.00');

      const before = await h.prisma.ledgerEntry.count({ where: { walletId: wallet.id } });

      await h
        .http()
        .post('/v1/swaps')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', uniqueKey('failed'))
        .send({ fromCurrency: 'cNGN', toCurrency: 'USDx', amount: '5000.00' })
        .expect(422);

      // transactions and ledger_entries only ever hold committed money, which is
      // what keeps the net-zero invariant provable.
      expect(await h.prisma.ledgerEntry.count({ where: { walletId: wallet.id } })).toBe(before);

      // The attempt is still auditable, on its own table.
      const attempt = await h.prisma.transactionAttempt.findFirst({
        where: { walletId: wallet.id, outcome: 'FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(attempt?.errorCode).toBe('INSUFFICIENT_FUNDS');
      expect(attempt?.requestId).toMatch(/.+/);
    });

    it('replays a deterministic failure instead of recomputing it', async () => {
      const wallet = await createWallet(h, 'replay-fail');
      const key = uniqueKey('deterministic');
      const body = { fromCurrency: 'cNGN', toCurrency: 'USDx', amount: '999.00' };

      const first = await h
        .http()
        .post('/v1/swaps')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(422);

      const second = await h
        .http()
        .post('/v1/swaps')
        .set('authorization', `Bearer ${wallet.accessToken}`)
        .set('idempotency-key', key)
        .send(body)
        .expect(422);

      // Insufficient funds will fail identically forever, so the client gets a
      // stable answer rather than a freshly computed one each time.
      expect(errorCode(first.body)).toBe('INSUFFICIENT_FUNDS');
      expect(errorCode(second.body)).toBe(errorCode(first.body));
    });
  });
});
