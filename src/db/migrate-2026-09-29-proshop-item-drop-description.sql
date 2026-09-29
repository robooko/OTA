-- Drop proshop_item.description: nothing guest-facing ever read it. The one
-- venue site with a shop (willy-t-bvi) takes product copy from its own Sanity
-- `product` docs, matched to OTA items by name, and drops OTA's field.
-- shop.description (the shop's own blurb) is unaffected.

ALTER TABLE proshop_item DROP COLUMN IF EXISTS description;
