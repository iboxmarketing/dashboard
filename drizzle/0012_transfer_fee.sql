-- Transfer commission (Bank komissiyasi).
--
-- Additive: one nullable column. Existing transfers keep their history and read
-- as fee = 0; no row is rewritten, nothing is dropped, and no exchange rate is
-- invented for past transfers. The commission is denominated in the SOURCE
-- account's currency, so no second currency column is needed.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS: apply this file exactly once per
-- database (docs/FINANCE.md, "Later staging application").
ALTER TABLE `finance_transactions` ADD COLUMN `fee_amount_minor` integer;
