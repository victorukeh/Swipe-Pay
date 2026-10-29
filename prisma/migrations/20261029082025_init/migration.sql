-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'SWAP', 'TRANSFER');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "RateSource" AS ENUM ('LIVE', 'CACHED', 'STALE', 'FALLBACK', 'PEGGED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_FLIGHT', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "currencies" (
    "code" TEXT NOT NULL,
    "peg" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "minor_unit" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "system_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "wallet_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "balances" (
    "wallet_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("wallet_id","currency")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "source_wallet_id" UUID NOT NULL,
    "dest_wallet_id" UUID,
    "source_currency" TEXT NOT NULL,
    "source_amount" BIGINT NOT NULL,
    "dest_currency" TEXT NOT NULL,
    "dest_amount" BIGINT NOT NULL,
    "rate_scaled" BIGINT NOT NULL,
    "rate_source" "RateSource" NOT NULL,
    "rate_as_of" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_attempts" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "request_hash" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "transaction_id" UUID,
    "error_code" TEXT,
    "error_message" TEXT,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "wallet_id" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "transaction_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "fx_rate_snapshots" (
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate_scaled" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fx_rate_snapshots_pkey" PRIMARY KEY ("base","quote")
);

-- CreateIndex
CREATE INDEX "currencies_is_active_sort_order_idx" ON "currencies"("is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_email_key" ON "wallets"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_phone_key" ON "wallets"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_system_key_key" ON "wallets"("system_key");

-- CreateIndex
CREATE INDEX "balances_currency_idx" ON "balances"("currency");

-- CreateIndex
CREATE INDEX "transactions_source_wallet_id_created_at_idx" ON "transactions"("source_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_dest_wallet_id_created_at_idx" ON "transactions"("dest_wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_wallet_id_created_at_id_idx" ON "ledger_entries"("wallet_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "ledger_entries_wallet_id_currency_idx" ON "ledger_entries"("wallet_id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_attempts_wallet_id_created_at_id_idx" ON "transaction_attempts"("wallet_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "transaction_attempts_outcome_idx" ON "transaction_attempts"("outcome");

-- CreateIndex
CREATE INDEX "idempotency_records_wallet_id_idx" ON "idempotency_records"("wallet_id");

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_wallet_id_fkey" FOREIGN KEY ("source_wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_dest_wallet_id_fkey" FOREIGN KEY ("dest_wallet_id") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_currency_fkey" FOREIGN KEY ("source_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_dest_currency_fkey" FOREIGN KEY ("dest_currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attempts" ADD CONSTRAINT "transaction_attempts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_attempts" ADD CONSTRAINT "transaction_attempts_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints Prisma's schema language cannot express.
--
-- These are the invariants that make money handling trustworthy. They are
-- enforced in the application too, but a database that *cannot* represent a
-- negative balance is a stronger guarantee than one that merely isn't asked to.
-- ---------------------------------------------------------------------------

-- A customer balance can never go negative. If a bug ever skipped the
-- application check, the transaction aborts here instead of silently creating
-- money.
--
-- Internal clearing accounts are exempt, because a clearing account carrying a
-- negative (credit) position is correct accounting rather than a bug:
-- SYSTEM_MINT sits negative by the total supply it has issued, and SYSTEM_FX
-- sits negative in whichever currency it is currently paying out of.
ALTER TABLE "balances"
  ADD CONSTRAINT "balances_amount_non_negative"
  CHECK ("allow_negative" = true OR "amount" >= 0);

-- Ledger entries carry their sign in `direction`, so the magnitude is positive.
-- Zero-value entries are not written at all.
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0);

-- No zero-value or negative movements, and no zero/negative FX rate.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_source_amount_positive" CHECK ("source_amount" > 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_dest_amount_positive" CHECK ("dest_amount" > 0);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_rate_positive" CHECK ("rate_scaled" > 0);

-- A deposit has no counterparty; a swap's counterparty is the same wallet; a
-- transfer always has a distinct counterparty. Encoding this stops a malformed
-- transfer-to-self or a transfer with a missing receiver from being persisted.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_shape_matches_type" CHECK (
    ("type" = 'DEPOSIT'  AND "dest_wallet_id" IS NULL)
    OR ("type" = 'SWAP'     AND "dest_wallet_id" = "source_wallet_id")
    OR ("type" = 'TRANSFER' AND "dest_wallet_id" IS NOT NULL AND "dest_wallet_id" <> "source_wallet_id")
  );

ALTER TABLE "fx_rate_snapshots"
  ADD CONSTRAINT "fx_rate_snapshots_rate_positive" CHECK ("rate_scaled" > 0);

-- A wallet is reachable by email or phone; system wallets by neither.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_contact_required" CHECK (
    "is_system" = true OR "email" IS NOT NULL OR "phone" IS NOT NULL
  );

-- Contacts are stored normalised, so the plain unique indexes are sufficient:
-- the database refuses to hold a value that isn't already canonical, which means
-- "Ada@Example.COM" can never slip past "ada@example.com".
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_email_normalised" CHECK ("email" IS NULL OR "email" = lower("email"));

-- E.164: a leading '+', a non-zero country code, 7-15 digits in total.
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_phone_e164" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');

-- A completed idempotency record must have a response to replay; an in-flight
-- one must not.
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_response_matches_state" CHECK (
    ("state" = 'IN_FLIGHT' AND "response_status" IS NULL)
    OR ("state" <> 'IN_FLIGHT' AND "response_status" IS NOT NULL)
  );

-- An attempt either names the transaction it became, or the error it failed with.
ALTER TABLE "transaction_attempts"
  ADD CONSTRAINT "transaction_attempts_outcome_consistent" CHECK (
    ("outcome" = 'SUCCEEDED' AND "transaction_id" IS NOT NULL AND "error_code" IS NULL)
    OR ("outcome" = 'FAILED' AND "error_code" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Currency metadata guards.
--
-- The currencies table is the sole authority for which stablecoins exist and
-- what precision each admits, so a new currency is an INSERT rather than a
-- release. That convenience makes two columns dangerous, and both are guarded
-- here rather than relying on operator discipline.
-- ---------------------------------------------------------------------------

ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_decimals_range" CHECK ("decimals" >= 0 AND "decimals" <= 18);

ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_code_shape" CHECK ("code" ~ '^[A-Za-z][A-Za-z0-9]{1,15}$');

ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_peg_shape" CHECK ("peg" ~ '^[A-Z]{3}$');

-- `sort_order` is a fractional index: a new currency is slotted between two
-- existing ones with (left + right) / 2, so nothing is ever renumbered. It is
-- NUMERIC rather than DOUBLE PRECISION because that midpoint has to stay exact;
-- with binary floating point, successive midpoints would eventually collide and
-- the ordering would become non-deterministic.
ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_sort_order_non_negative" CHECK ("sort_order" >= 0);

-- `decimals` is the column that can destroy the ledger.
--
-- Every amount is stored as an integer count of minor units, so the number of
-- decimal places is what gives a stored integer its meaning. Changing cNGN from
-- 2 to 3 would silently reinterpret 123456 from 1234.56 to 123.456 — across
-- every balance, every ledger entry and every historical transaction, with no
-- migration and nothing in the audit trail.
--
-- So: freely editable while a currency is unused, immutable the moment any money
-- references it. Withdrawing a currency is done with is_active, not by editing
-- its precision.
CREATE OR REPLACE FUNCTION "currencies_guard_decimals"() RETURNS trigger AS $$
BEGIN
  IF NEW."decimals" IS DISTINCT FROM OLD."decimals" THEN
    IF EXISTS (SELECT 1 FROM "balances" WHERE "currency" = OLD."code" AND "amount" <> 0)
       OR EXISTS (SELECT 1 FROM "ledger_entries" WHERE "currency" = OLD."code")
       OR EXISTS (SELECT 1 FROM "transactions"
                  WHERE "source_currency" = OLD."code" OR "dest_currency" = OLD."code")
    THEN
      RAISE EXCEPTION
        'cannot change decimals for currency % : % balance/ledger rows already interpret amounts at % decimals',
        OLD."code", 'existing', OLD."decimals"
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'Deactivate the currency with is_active = false and introduce a new code instead.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "currencies_guard_decimals"
  BEFORE UPDATE ON "currencies"
  FOR EACH ROW EXECUTE FUNCTION "currencies_guard_decimals"();

-- Changing a code would orphan every FK that points at it; renaming is not a
-- supported operation.
CREATE OR REPLACE FUNCTION "currencies_guard_code"() RETURNS trigger AS $$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'currency codes are immutable (attempted % -> %)', OLD."code", NEW."code"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "currencies_guard_code"
  BEFORE UPDATE ON "currencies"
  FOR EACH ROW EXECUTE FUNCTION "currencies_guard_code"();
