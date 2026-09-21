-- Public share links record whose access vouches for them.
--
-- The public share route re-checks this user's CURRENT permissions on every
-- read, so a revoked permission, a deactivated account or a later widget
-- change stops the link serving that data at once. Existing shares have no
-- owner (NULL) and serve only permission-free widgets until an authorised
-- user re-saves them. Additive only: one nullable column.
ALTER TABLE `page_share_tokens` ADD `owner_user_id` text;
