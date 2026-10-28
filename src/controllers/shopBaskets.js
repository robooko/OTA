const pool = require('../db');
const { publishBasketUpdated } = require('../lib/ably');
const { isValidUuid } = require('../middleware/validate');
const { upsertBasket, listOpenBaskets, getOpenBasketFor } = require('../lib/shopBaskets');

async function saveBasket(req, res, next) {
  try {
    const { shop_id, clerk_user_id } = req.body;
    if (!shop_id || !clerk_user_id) return res.status(400).json({ error: 'shop_id and clerk_user_id are required' });
    if (!isValidUuid(shop_id)) return res.status(404).json({ error: 'Shop not found' });
    const { rows } = await pool.query(`SELECT id FROM shop WHERE id = $1 AND property_id = $2`, [shop_id, req.property_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Shop not found' });
    const basket = await upsertBasket(pool, req.property_id, req.body);
    publishBasketUpdated(req.property_id, basket).catch(console.error);
    res.json(basket);
  } catch (err) { next(err); }
}

async function listBaskets(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
    res.json(await listOpenBaskets(pool, req.property_id, limit));
  } catch (err) { next(err); }
}

async function myBasket(req, res, next) {
  try {
    const { shop_id, clerk_user_id } = req.query;
    if (!shop_id || !clerk_user_id) return res.status(400).json({ error: 'shop_id and clerk_user_id are required' });
    if (!isValidUuid(shop_id)) return res.json({ items: [] });
    const b = await getOpenBasketFor(pool, req.property_id, shop_id, clerk_user_id);
    res.json({ items: b ? b.items.map(({ item_id, quantity }) => ({ item_id, quantity })) : [] });
  } catch (err) { next(err); }
}

module.exports = { saveBasket, listBaskets, myBasket };
