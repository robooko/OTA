-- Groups shop item variants (colour/size) that are today separate
-- proshop_item rows -- e.g. "Trucker Hat (Black)" / "(Grey)" / "(Pink)" --
-- into one product for display, while keeping each variant's own price and
-- stock_quantity exactly as they are now (a real, independently-tracked
-- proshop_item row, not a shared label array like restaurant_menu_item's
-- `variants` -- that shape has no room for per-variant stock, which is the
-- whole point here).
--
-- product_group: a key shared by every row belonging to one product (any
-- stable string is fine -- the admin dashboard and website group by exact
-- match, nothing parses it). NULL (the default) = standalone, ungrouped
-- item, unchanged from today's behaviour.
-- variant_label: this row's option value within the group (e.g. "Black"),
-- shown next to/instead of a picker. NULL is fine even inside a group (falls
-- back to the item's own name).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE proshop_item
  ADD COLUMN IF NOT EXISTS product_group VARCHAR(100),
  ADD COLUMN IF NOT EXISTS variant_label VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_proshop_item_product_group ON proshop_item(product_group);
