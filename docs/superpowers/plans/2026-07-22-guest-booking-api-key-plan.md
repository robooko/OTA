# API Key Auth for POST /api/guests and /api/bookings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `POST /api/guests` and `POST /api/bookings` accept either the existing JWT or the shared `X-Api-Key` header, with `property_id` supplied in the body when using the API key — per `docs/superpowers/specs/2026-07-22-guest-booking-api-key-design.md`.

**Architecture:** One new middleware, `authenticateOrApiKey`, added to `src/middleware/auth.js` alongside the existing `authenticate`. It delegates to `authenticate` when a Bearer token is present, otherwise validates `X-Api-Key` + a body-supplied `property_id`. Only the two `POST` routes on `routes/guests.js` and `routes/bookings.js` switch to it; every other route, and both controllers, are untouched.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL, `jsonwebtoken`.

## Global Constraints

- No automated test framework exists in this project (no jest/mocha, no `test` script). Every "verify" step in this plan is a **manual check**: a `curl` command against a running `npm run dev` server, with the exact expected output.
- Two databases: local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance backing `https://ota-u6ii.onrender.com`. Unlike the BBYC-rooms plan, this change touches **code**, so it requires an actual `git push` + Render redeploy to reach live — not just a direct DB write.
- Confirm with the user before pushing to `origin/main`, per this project's established practice for any push that triggers a live Render redeploy.
- Today's date: **2026-07-22**. Use BBYC (property id `e1000000-0000-0000-0000-000000000004`, from the `2026-07-22-bbyc-rooms-plan.md` work) as the test property — it already has rooms and availability seeded through `2026-10-20`.
- The local `.env`'s `API_KEY` value is used for all `X-Api-Key` test calls: read it fresh with `grep '^API_KEY=' .env | cut -d= -f2` rather than hardcoding it in this plan.
- Scope is exactly `POST /api/guests` and `POST /api/bookings`. Do not add API-key support to any other route, and do not modify `controllers/guests.js` or `controllers/bookings.js` — both already work unchanged once `req.property_id` is set correctly.

---

### Task 1: Add `authenticateOrApiKey` middleware and wire it into both POST routes

**Files:**
- Modify: `src/middleware/auth.js` (full file, currently 30 lines)
- Modify: `src/routes/guests.js:1-11`
- Modify: `src/routes/bookings.js:1-9`

**Interfaces:**
- Consumes: `isValidUuid` from `src/middleware/validate.js` (already exported there), `pool` from `src/db/index.js`.
- Produces: `authenticateOrApiKey(req, res, next)` — Express middleware. On success sets `req.property_id` (string UUID); on the JWT path also sets `req.user` (unchanged from `authenticate`), on the API-key path leaves `req.user` `undefined`.

- [ ] **Step 1: Add the middleware**

Replace the full contents of `src/middleware/auth.js`:

```js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.property_id = req.user.property_id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
```

with:

```js
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { isValidUuid } = require('./validate');

const JWT_SECRET = process.env.JWT_SECRET;

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.property_id = req.user.property_id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
  }

  const { property_id } = req.body;
  if (!property_id || !isValidUuid(property_id)) {
    return res.status(400).json({ error: 'property_id is required and must be a valid UUID when authenticating with X-Api-Key' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM property WHERE id = $1', [property_id]);
    if (!rows.length) return res.status(404).json({ error: 'Property not found' });
    req.property_id = property_id;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authenticateOrApiKey, requireRole };
```

- [ ] **Step 2: Wire it into `POST /api/guests`**

In `src/routes/guests.js`, replace:

```js
const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listGuests);
router.get('/lookup', authenticate, ctrl.lookupGuest);
router.get('/:id', authenticate, ctrl.getGuest);
router.get('/:id/summary', authenticate, ctrl.getGuestSummary);
router.post('/', authenticate, ctrl.createGuest);
router.put('/:id', authenticate, ctrl.updateGuest);
router.delete('/:id', authenticate, ctrl.deleteGuest);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listGuests);
router.get('/lookup', authenticate, ctrl.lookupGuest);
router.get('/:id', authenticate, ctrl.getGuest);
router.get('/:id/summary', authenticate, ctrl.getGuestSummary);
router.post('/', authenticateOrApiKey, ctrl.createGuest);
router.put('/:id', authenticate, ctrl.updateGuest);
router.delete('/:id', authenticate, ctrl.deleteGuest);

module.exports = router;
```

- [ ] **Step 3: Wire it into `POST /api/bookings`**

In `src/routes/bookings.js`, replace:

```js
const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listBookings);
router.get('/:id', authenticate, ctrl.getBooking);
router.post('/', authenticate, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticate, ctrl.cancelBooking);

module.exports = router;
```

with:

```js
const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listBookings);
router.get('/:id', authenticate, ctrl.getBooking);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticate, ctrl.cancelBooking);

module.exports = router;
```

- [ ] **Step 4: Restart the dev server**

`nodemon` should pick up the file changes automatically (it's already watching `*.*`), but confirm:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`. If it doesn't respond, start it: `npm run dev` (background) and wait for `Server running on port 3000` in its output.

- [ ] **Step 5: Verify JWT auth on both POST routes still works unchanged**

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@bbyc.example.com","password":"Bbyc-dE3OSnze!1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"first_name":"JWT","last_name":"Guest","email":"jwt.guest@example.com"}'
```
Expected: `201`, `"property_id":"e1000000-0000-0000-0000-000000000004"` in the response (from the token, not the body — the body didn't include `property_id` at all).

- [ ] **Step 6: Verify API-key auth creates a guest for the property named in the body**

```bash
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"first_name":"ApiKey","last_name":"Guest","email":"apikey.guest@example.com","property_id":"e1000000-0000-0000-0000-000000000004"}'
```
Expected: `201`, `"property_id":"e1000000-0000-0000-0000-000000000004"`. Save the returned `id` as `APIKEY_GUEST_ID` for the next step.

- [ ] **Step 7: Verify API-key auth creates a booking**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d "{\"property_id\":\"e1000000-0000-0000-0000-000000000004\",\"guest_id\":\"$APIKEY_GUEST_ID\",\"room_id\":\"b4000000-0000-0000-0000-000000000002\",\"check_in\":\"2026-08-10\",\"check_out\":\"2026-08-12\",\"guests\":2}"
```
Expected: `201`, `"property_id":"e1000000-0000-0000-0000-000000000004"`, `"total_price":"900.00"`.

- [ ] **Step 8: Verify the four error cases**

```bash
echo "--- missing property_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"first_name":"No","last_name":"Property","email":"no.property@example.com"}'

echo "--- malformed property_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"first_name":"Bad","last_name":"Property","email":"bad.property@example.com","property_id":"not-a-uuid"}'

echo "--- nonexistent property_id ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" -d '{"first_name":"Ghost","last_name":"Property","email":"ghost.property@example.com","property_id":"00000000-0000-0000-0000-000000000000"}'

echo "--- no auth at all ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -d '{"first_name":"No","last_name":"Auth","email":"no.auth@example.com"}'
```
Expected in order: `400 {"error":"property_id is required and must be a valid UUID when authenticating with X-Api-Key"}`; `400` with the same message (malformed UUID fails `isValidUuid`); `404 {"error":"Property not found"}`; `401 {"error":"Missing or invalid Authorization header or X-Api-Key"}`.

- [ ] **Step 9: Verify GET/PUT/DELETE still reject the API key (JWT-only, unchanged)**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" http://localhost:3000/api/guests -H "X-Api-Key: $API_KEY"
```
Expected: `401 {"error":"Missing or invalid Authorization header"}` — confirms `GET /api/guests` still runs the old `authenticate`, not the new middleware (its error message doesn't mention `X-Api-Key`, unlike Step 8's).

- [ ] **Step 10: Commit**

```bash
git add src/middleware/auth.js src/routes/guests.js src/routes/bookings.js
git commit -m "Accept X-Api-Key (with body property_id) on POST /api/guests and /api/bookings"
```

---

### Task 2: Document the new auth option in Swagger

**Files:**
- Modify: `src/docs/swagger.js:31-38` (`components.securitySchemes`)
- Modify: `src/docs/swagger.js:169-197` (`/api/guests` path — `post` block)
- Modify: `src/docs/swagger.js:248` (`/api/bookings` path — `post` block)

**Interfaces:**
- Consumes: nothing from Task 1 (documentation only, doesn't affect runtime behavior).
- Produces: `apiKeyAuth` OpenAPI security scheme, referenced only by these two paths' `post` entries.

- [ ] **Step 1: Add the `apiKeyAuth` security scheme**

Replace:

```js
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
```

with:

```js
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
      },
    },
```

- [ ] **Step 2: Document `POST /api/guests`**

Replace:

```js
      post: {
        tags: ['Guests'],
        summary: 'Create a guest',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['first_name', 'last_name', 'email'],
                properties: {
                  first_name: { type: 'string' },
                  last_name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  phone: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Guest created' } },
      },
```

with:

```js
      post: {
        tags: ['Guests'],
        summary: 'Create a guest',
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['first_name', 'last_name', 'email'],
                properties: {
                  first_name: { type: 'string' },
                  last_name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  phone: { type: 'string' },
                  property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Guest created' } },
      },
```

- [ ] **Step 3: Document `POST /api/bookings`**

Replace (this is currently one long line):

```js
      post: { tags: ['Bookings'], summary: 'Create booking', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'room_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'InterContinental Le Moana Bora Bora Resort' } } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room not available' } } },
```

with:

```js
      post: { tags: ['Bookings'], summary: 'Create booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'room_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'InterContinental Le Moana Bora Bora Resort' } }, property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room not available' } } },
```

- [ ] **Step 4: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  console.log('securitySchemes:', Object.keys(j.components.securitySchemes));
  console.log('guests POST security:', JSON.stringify(j.paths['/api/guests'].post.security));
  console.log('guests POST has property_id:', 'property_id' in j.paths['/api/guests'].post.requestBody.content['application/json'].schema.properties);
  console.log('bookings POST security:', JSON.stringify(j.paths['/api/bookings'].post.security));
  console.log('bookings POST has property_id:', 'property_id' in j.paths['/api/bookings'].post.requestBody.content['application/json'].schema.properties);
});
"
```
Expected: `securitySchemes: [ 'bearerAuth', 'apiKeyAuth' ]`; both `security` lines print `[{"bearerAuth":[]},{"apiKeyAuth":[]}]`; both `has property_id` lines print `true`.

- [ ] **Step 5: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document X-Api-Key auth option on POST /api/guests and /api/bookings"
```

---

### Task 3: Push and verify live

**Files:** none (deploy + verification only).

**Interfaces:**
- Consumes: Task 1 and Task 2's commits.

- [ ] **Step 1: Confirm with the user before pushing**

Per this project's established practice for any push to `origin/main` (it triggers a live Render redeploy of actual code, unlike the data-only BBYC rooms change).

- [ ] **Step 2: Push**

```bash
git push origin main
```

- [ ] **Step 3: Wait for Render to redeploy**

```bash
for i in $(seq 1 20); do
  RESULT=$(curl -s https://ota-u6ii.onrender.com/api/docs.json 2>/dev/null | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const j = JSON.parse(d);
    console.log('apiKeyAuth' in j.components.securitySchemes ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually prints `READY`.

- [ ] **Step 4: Repeat Task 1 Steps 6-9 against the live service**

Same requests as Task 1, but against `https://ota-u6ii.onrender.com` instead of `http://localhost:3000`, and using the live `otadb` BBYC admin credentials (same email/password — this was set on both databases in the earlier password-change work) and a fresh date range (e.g. `2026-08-15`–`2026-08-17`) to avoid colliding with any booking already made on `otadb` during local-vs-live testing of prior features.

Expected: identical status codes and error messages to Task 1's local runs.

- [ ] **Step 5: No further action** — this task is deploy + verification only. If any expected output didn't match, the code is already live; fix forward with a new commit rather than reverting, and re-run from Step 2.
