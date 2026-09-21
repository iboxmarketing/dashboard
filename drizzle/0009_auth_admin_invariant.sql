-- At least one active ADMIN must always exist.
--
-- Enforced by the database rather than by a count read in JavaScript: a read
-- followed by a later UPDATE lets two concurrent demotions each see "one other
-- admin left" and together leave none. SQLite runs these triggers inside the
-- writing statement, and D1 serialises writes, so the second of two concurrent
-- demotions sees the first one's result and is aborted — rolling back the
-- whole batch it belongs to.
--
-- Additive only: no table, column or row changes.
CREATE TRIGGER `app_users_keep_active_admin_update`
BEFORE UPDATE OF `role`, `active` ON `app_users`
FOR EACH ROW
WHEN OLD.`role` = 'ADMIN' AND OLD.`active` = 1
  AND (NEW.`role` <> 'ADMIN' OR NEW.`active` <> 1)
  AND NOT EXISTS (
    SELECT 1 FROM `app_users`
     WHERE `role` = 'ADMIN' AND `active` = 1 AND `id` <> OLD.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'LAST_ACTIVE_ADMIN');
END;
--> statement-breakpoint
CREATE TRIGGER `app_users_keep_active_admin_delete`
BEFORE DELETE ON `app_users`
FOR EACH ROW
WHEN OLD.`role` = 'ADMIN' AND OLD.`active` = 1
  AND NOT EXISTS (
    SELECT 1 FROM `app_users`
     WHERE `role` = 'ADMIN' AND `active` = 1 AND `id` <> OLD.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'LAST_ACTIVE_ADMIN');
END;
