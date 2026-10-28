const { unitPrice } = require('../controllers/proshop');

// One open basket per signed-in guest per shop. Prices always come from
// proshop_item, never from the client.
async function upsertBasket(db, propertyId, { shop_id, clerk_user_id, contact_email, contact_name, items, return_url }) {
  const wanted = (Array.isArray(items) ? items : [])
    .map((i) => ({ item_id: i && i.item_id, quantity: parseInt(i && i.quantity, 10) }))
    .filter((i) => typeof i.item_id === 'string' && i.quantity > 0);
  let priced = [];
  if (wanted.length) {
    const { rows: catalog } = await db.query(
      `SELECT id, name, price, sale_price FROM proshop_item
        WHERE id = ANY($1::uuid[]) AND shop_id = $2 AND property_id = $3 AND status = 'active'`,
      [wanted.map((i) => i.item_id), shop_id, propertyId]
    );
    const byId = new Map(catalog.map((c) => [c.id, c]));
    priced = wanted.filter((i) => byId.has(i.item_id)).map((i) => {
      const c = byId.get(i.item_id);
      return { item_id: c.id, item_name: c.name, unit_price: unitPrice(c), quantity: i.quantity };
    });
  }
  const subtotal = priced.reduce((s, i) => s + i.unit_price * i.quantity, 0).toFixed(2);

  if (!priced.length) {
    const { rows } = await db.query(
      `UPDATE shop_basket SET items = '[]', items_subtotal = 0, status = 'expired', updated_at = now()
        WHERE property_id = $1 AND shop_id = $2 AND clerk_user_id = $3 AND status = 'open' RETURNING *`,
      [propertyId, shop_id, clerk_user_id]
    );
    if (rows[0]) return rows[0];
    // ponytail: nothing open to expire, so insert-and-expire a row only to honour "returns the row"
    const ins = await db.query(
      `INSERT INTO shop_basket (property_id, shop_id, clerk_user_id, contact_email, contact_name, return_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,'expired') RETURNING *`,
      [propertyId, shop_id, clerk_user_id, contact_email || null, contact_name || null, return_url || null]
    );
    return ins.rows[0];
  }

  const { rows } = await db.query(
    `INSERT INTO shop_basket (property_id, shop_id, clerk_user_id, contact_email, contact_name, items, items_subtotal, return_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (property_id, shop_id, clerk_user_id) WHERE status = 'open' DO UPDATE SET
       contact_email = COALESCE(EXCLUDED.contact_email, shop_basket.contact_email),
       contact_name = COALESCE(EXCLUDED.contact_name, shop_basket.contact_name),
       items = EXCLUDED.items, items_subtotal = EXCLUDED.items_subtotal,
       return_url = COALESCE(EXCLUDED.return_url, shop_basket.return_url),
       updated_at = now()
     RETURNING *`,
    [propertyId, shop_id, clerk_user_id, contact_email || null, contact_name || null,
      JSON.stringify(priced), subtotal, return_url || null]
  );
  return rows[0];
}

async function listOpenBaskets(db, propertyId, limit) {
  const { rows } = await db.query(
    `SELECT b.id, b.contact_name, b.contact_email, b.items, b.items_subtotal, b.updated_at, b.reminder_sent_at,
            CASE WHEN p.basket_reminder_enabled AND NULLIF(trim(b.contact_email), '') IS NOT NULL
                  AND b.reminder_sent_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM basket_reminder_opt_out o
                                   WHERE o.property_id = b.property_id AND lower(trim(o.email)) = lower(trim(b.contact_email)))
                 THEN b.updated_at + make_interval(mins => p.basket_reminder_delay_mins) END AS reminder_due_at
       FROM shop_basket b JOIN property p ON p.id = b.property_id
      WHERE b.property_id = $1 AND b.status = 'open'
      ORDER BY b.updated_at DESC LIMIT $2`,
    [propertyId, limit]
  );
  return rows;
}

async function getOpenBasketFor(db, propertyId, shopId, clerkUserId) {
  const { rows } = await db.query(
    `SELECT * FROM shop_basket WHERE property_id = $1 AND shop_id = $2 AND clerk_user_id = $3 AND status = 'open'`,
    [propertyId, shopId, clerkUserId]
  );
  return rows[0] || null;
}

module.exports = { upsertBasket, listOpenBaskets, getOpenBasketFor };
