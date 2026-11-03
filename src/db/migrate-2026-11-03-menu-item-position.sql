-- Display order for menu items, within their category. Existing rows all start
-- at 0, so they keep their old by-name order until someone reorders them.
ALTER TABLE restaurant_menu_item ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;
