-- Soft-delete a Finance transaction: archive instead of destroying history.
--
-- Additive: one column with a default, so every existing row is active. An
-- archived transaction stops affecting balances, income, expense and category
-- totals, stays readable in the Archive view, and can be restored exactly once.
-- Nothing is dropped and no row is rewritten.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS: apply once per database, before
-- deploying the build that writes the column (docs/FINANCE.md).
ALTER TABLE `finance_transactions` ADD COLUMN `archived` integer DEFAULT 0 NOT NULL;
