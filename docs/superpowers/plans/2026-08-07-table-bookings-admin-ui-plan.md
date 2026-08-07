# Table Bookings Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Astro + Vercel internal dashboard letting logged-in staff view, create, edit, and cancel restaurant table reservations against the existing OTA API, without ever exposing that API's shared restaurant-module key to the browser.

**Architecture:** A new repository, `ota-table-bookings`, sibling to `OTA` at `c:\Users\robert\source\repos\ota-table-bookings`. Astro in `output: 'server'` mode on the `@astrojs/vercel` adapter. Every Astro page/route runs server-side (on Vercel, as serverless functions); a small set of Astro API routes act as a proxy layer that holds the OTA API's shared `X-Api-Key` and a staff JWT session cookie, and the only thing the browser ever calls is this app's own `/api/*` routes. Interactive pieces (reservation list refresh, create/cancel/edit) are plain-JS client islands — no UI framework.

**Tech Stack:** Astro (latest, TypeScript), `@astrojs/vercel` adapter, no additional runtime dependencies. No automated test framework — this mirrors the OTA backend's own convention (see `docs/superpowers/specs/2026-08-07-table-bookings-admin-ui-design.md`, "Testing approach"); every task below is verified with `curl` or a browser instead.

Reference spec: `docs/superpowers/specs/2026-08-07-table-bookings-admin-ui-design.md` (in the `OTA` repo — this new project doesn't carry its own copy).

## Global Constraints

- New standalone repository, not a folder inside the `OTA` repo.
- `output: 'server'` with `@astrojs/vercel` — this app must deploy to Vercel.
- Client-side interactivity is plain `fetch()` + DOM APIs — no React/Preact/Vue/etc.
- The OTA API's shared restaurant-module key (`OTA_API_KEY`) is read only inside this app's server-side code (Astro API routes) and must never appear in any response body, HTML, or script sent to the browser.
- Session cookie (`ota_session`) must be `httpOnly`, `Secure`, `SameSite=Lax`.
- No restaurant-level access control — any authenticated staff member can manage any restaurant's reservations.
- v1 covers reservations only — no table/service-period/seasonal-closure management UI.
- No independent verification of the staff JWT's signature in this app (no `JWT_SECRET` here) — the cookie is a UX gate only; the OTA backend's own `X-Api-Key` check is the real authorization boundary for every write.

---

### Task 1: Scaffold the Astro project with the Vercel adapter

**Files:**
- Create: `ota-table-bookings/` (new directory + git repo at `c:\Users\robert\source\repos\ota-table-bookings`)
- Create: `ota-table-bookings/astro.config.mjs`
- Create: `ota-table-bookings/.gitignore`
- Create: `ota-table-bookings/.env.example`
- Create: `ota-table-bookings/.env` (local only, gitignored)

**Interfaces:**
- Produces: a running Astro dev server at `http://localhost:4321`, with `import.meta.env.OTA_API_BASE_URL` and `import.meta.env.OTA_API_KEY` available to server-side code (consumed by Task 2's `src/lib/ota-client.ts`).

- [ ] **Step 1: Scaffold the project**

Run from `c:\Users\robert\source\repos`:

```bash
npm create astro@latest ota-table-bookings -- --template minimal --no-install --no-git --typescript strict
cd ota-table-bookings
npm install
```

- [ ] **Step 2: Add the Vercel adapter**

```bash
npx astro add vercel --yes
```

- [ ] **Step 3: Confirm/set server output mode**

Open `astro.config.mjs`. Confirm it looks like this (adjust only if `astro add` produced a different import path for the adapter — the key requirement is `output: 'server'` plus a `vercel()` adapter):

```js
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
});
```

- [ ] **Step 4: Add `.gitignore` entries**

Ensure `ota-table-bookings/.gitignore` contains at least:

```
node_modules/
dist/
.vercel/
.env
```

(the Astro scaffold already creates most of this — just confirm `.env` is present; add it if not.)

- [ ] **Step 5: Create `.env.example` and `.env`**

`ota-table-bookings/.env.example`:

```
OTA_API_BASE_URL=https://ota-u6ii.onrender.com
OTA_API_KEY=replace-with-the-shared-restaurant-module-key
```

`ota-table-bookings/.env` (real local values — copy `OTA_API_KEY`'s actual value from the `API_KEY` entry in the `OTA` repo's own `.env` file; do not invent a new key):

```
OTA_API_BASE_URL=https://ota-u6ii.onrender.com
OTA_API_KEY=<paste the real value here>
```

- [ ] **Step 6: Verify the dev server boots**

```bash
npm run dev
```

Expected: server starts on `http://localhost:4321` with no errors. Visit it in a browser — the default Astro welcome page from the `minimal` template loads. Stop the server (Ctrl+C).

- [ ] **Step 7: Init git and commit**

```bash
git init
git add -A
git commit -m "Scaffold Astro project with Vercel adapter"
```

---

### Task 2: OTA API client helper + restaurants list proxy route

**Files:**
- Create: `src/lib/ota-client.ts`
- Create: `src/env.d.ts`
- Create: `src/pages/api/restaurants/index.ts`

**Interfaces:**
- Consumes: `import.meta.env.OTA_API_BASE_URL`, `import.meta.env.OTA_API_KEY` (Task 1).
- Produces: `otaRequest(path: string, options?: { method?: string; body?: unknown; useApiKey?: boolean }): Promise<{ status: number; data: any }>` — used by every later proxy route (Tasks 5, 6, 7).

- [ ] **Step 1: Declare the env vars for TypeScript**

`src/env.d.ts`:

```ts
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly OTA_API_BASE_URL: string;
  readonly OTA_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 2: Write the OTA client helper**

`src/lib/ota-client.ts`:

```ts
export async function otaRequest(
  path: string,
  options: { method?: string; body?: unknown; useApiKey?: boolean } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.useApiKey) {
    headers['X-Api-Key'] = import.meta.env.OTA_API_KEY;
  }

  let res: Response;
  try {
    res = await fetch(`${import.meta.env.OTA_API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    return { status: 502, data: { error: 'Upstream API unavailable' } };
  }

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
```

- [ ] **Step 3: Write the restaurants list proxy route**

`src/pages/api/restaurants/index.ts`:

```ts
import type { APIRoute } from 'astro';
import { otaRequest } from '../../../lib/ota-client';

export const GET: APIRoute = async () => {
  const { status, data } = await otaRequest('/api/restaurant');
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};
```

- [ ] **Step 4: Verify against the real OTA API**

```bash
npm run dev
```

In another terminal:

```bash
curl -s http://localhost:4321/api/restaurants
```

Expected: `200`, a JSON array of restaurant objects (name, description, phone, etc.) — the same data `GET https://ota-u6ii.onrender.com/api/restaurant` returns directly. Note one restaurant's `id` from the output; it's needed for manual verification in later tasks.

Now verify the network-failure path: stop the dev server, temporarily set `OTA_API_BASE_URL=https://this-host-does-not-exist.invalid` in `.env`, restart `npm run dev`, and re-run the same `curl` command. Expected: `502`, body `{"error":"Upstream API unavailable"}`. Revert `.env` back to the real URL and restart the dev server before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ota-client.ts src/env.d.ts src/pages/api/restaurants/index.ts
git commit -m "Add OTA API client helper and restaurants list proxy route"
```

---

### Task 3: Session cookie helpers

**Files:**
- Create: `src/lib/session.ts`

**Interfaces:**
- Produces:
  - `SESSION_COOKIE: string` (constant, value `'ota_session'`)
  - `decodeExp(token: string): number | null`
  - `getSessionToken(cookies: import('astro').AstroCookies): string | null`
  - `setSessionCookie(cookies: import('astro').AstroCookies, token: string): void`
  - `clearSessionCookie(cookies: import('astro').AstroCookies): void`
  - Consumed by Task 4's middleware and Task 5's login/logout routes.

- [ ] **Step 1: Write the session helpers**

`src/lib/session.ts`:

```ts
import type { AstroCookies } from 'astro';

export const SESSION_COOKIE = 'ota_session';

export function decodeExp(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

export function getSessionToken(cookies: AstroCookies): string | null {
  const raw = cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const exp = decodeExp(raw);
  if (exp === null || exp * 1000 <= Date.now()) return null;
  return raw;
}

export function setSessionCookie(cookies: AstroCookies, token: string): void {
  const exp = decodeExp(token);
  const maxAge = exp ? Math.max(1, exp - Math.floor(Date.now() / 1000)) : 60 * 60 * 24;
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}
```

- [ ] **Step 2: Verify `decodeExp` manually**

Run this from `c:\Users\robert\source\repos\OTA` (not from `ota-table-bookings`) — that repo already has `jsonwebtoken` installed and is plain CommonJS, so `require` works with no setup. This only exercises the same base64url-decode-and-parse logic `decodeExp` uses; it doesn't touch either app's code directly.

```bash
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({ id: 1 }, 'test-secret', { expiresIn: '1h' });
const payload = token.split('.')[1];
const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
console.log(typeof json.exp === 'number' ? json.exp : null);
"
```

Expected: prints a Unix timestamp roughly one hour from now. This confirms the base64url-decode-and-parse logic used inside `decodeExp` is correct against a real JWT shape.

- [ ] **Step 3: Commit**

```bash
git add src/lib/session.ts
git commit -m "Add session cookie helpers"
```

---

### Task 4: Auth middleware

**Files:**
- Create: `src/middleware.ts`

**Interfaces:**
- Consumes: `getSessionToken` from `src/lib/session.ts` (Task 3).
- Produces: a request gate — unauthenticated requests to any path other than `/login`/`/api/login` get redirected (pages) or `401`'d (`/api/*`) before reaching any later task's code.

- [ ] **Step 1: Write the middleware**

`src/middleware.ts`:

```ts
import { defineMiddleware } from 'astro:middleware';
import { getSessionToken } from './lib/session';

const PUBLIC_PATHS = new Set(['/login', '/api/login']);

export const onRequest = defineMiddleware((context, next) => {
  if (PUBLIC_PATHS.has(context.url.pathname)) {
    return next();
  }

  const token = getSessionToken(context.cookies);
  if (!token) {
    if (context.url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return context.redirect('/login');
  }

  return next();
});
```

Note: the middleware only needs to decide "is there a valid session or not" — nothing later in this plan needs the token's value itself (the proxy routes authenticate to the OTA API with `OTA_API_KEY`, not the staff JWT), so there's no `context.locals` assignment here.

- [ ] **Step 2: Verify the gate is active**

```bash
npm run dev
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4321/api/restaurants
```

Expected: `401` (previously `200` in Task 2 — this confirms the middleware now blocks the unauthenticated request). Also visit `http://localhost:4321/` in a browser — expect a redirect to `/login` (a 404 page is fine for now, since `/login` doesn't exist until Task 5 — the important thing is the browser's URL bar shows `/login`).

- [ ] **Step 3: Commit**

```bash
git add src/middleware.ts
git commit -m "Add auth middleware gating all routes except /login and /api/login"
```

---

### Task 5: Login flow (`/login` page, `/api/login`, `/api/logout`)

**Files:**
- Create: `src/pages/login.astro`
- Create: `src/pages/api/login.ts`
- Create: `src/pages/api/logout.ts`
- Create: `src/pages/index.astro`

**Interfaces:**
- Consumes: `otaRequest` (Task 2), `setSessionCookie`/`clearSessionCookie` (Task 3).
- Produces: a working login/logout flow that Task 8's `/reservations` page relies on for access.

- [ ] **Step 1: Write the login API route**

`src/pages/api/login.ts`:

```ts
import type { APIRoute } from 'astro';
import { otaRequest } from '../../lib/ota-client';
import { setSessionCookie } from '../../lib/session';

export const POST: APIRoute = async ({ request, cookies }) => {
  const body = await request.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return new Response(JSON.stringify({ error: 'email and password are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { status, data } = await otaRequest('/api/auth/login', {
    method: 'POST',
    body: { email: body.email, password: body.password },
  });

  if (status !== 200) {
    return new Response(JSON.stringify(data ?? { error: 'Login failed' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  setSessionCookie(cookies, data.token);
  return new Response(JSON.stringify({ user: data.user }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
```

- [ ] **Step 2: Write the logout API route**

`src/pages/api/logout.ts`:

```ts
import type { APIRoute } from 'astro';
import { clearSessionCookie } from '../../lib/session';

export const POST: APIRoute = async ({ cookies }) => {
  clearSessionCookie(cookies);
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 3: Write the login page**

`src/pages/login.astro`:

```astro
---
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Log in — Table Bookings</title>
  </head>
  <body>
    <h1>Log in</h1>
    <form id="login-form">
      <label>Email <input type="email" name="email" required /></label>
      <label>Password <input type="password" name="password" required /></label>
      <button type="submit">Log in</button>
      <p id="login-error" style="color:red" hidden></p>
    </form>

    <script>
      const form = document.getElementById('login-form') as HTMLFormElement;
      const errorEl = document.getElementById('login-error') as HTMLParagraphElement;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;
        const formData = new FormData(form);
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: formData.get('email'),
            password: formData.get('password'),
          }),
        });
        if (res.ok) {
          window.location.href = '/reservations';
          return;
        }
        const data = await res.json().catch(() => ({ error: 'Login failed' }));
        errorEl.textContent = data.error ?? 'Login failed';
        errorEl.hidden = false;
      });
    </script>
  </body>
</html>
```

- [ ] **Step 4: Write the index redirect page**

`src/pages/index.astro`:

```astro
---
return Astro.redirect('/reservations');
---
```

- [ ] **Step 5: Verify the full login/logout cycle**

```bash
npm run dev
```

In a browser, visit `http://localhost:4321/` → redirected to `/login` (the middleware still blocks `/reservations`, which doesn't exist yet, but the redirect chain to `/login` should work). Log in with a real `api_user` email/password from the OTA database. Expected: redirected toward `/reservations` (this will 404 until Task 8 — that's fine, it confirms login succeeded and the cookie was set).

Confirm the cookie via devtools (Application/Storage tab → Cookies): `ota_session` present, `HttpOnly` checked, `Secure` checked (note: `Secure` cookies aren't set over plain `http://localhost` in some browsers — if the cookie doesn't appear locally for this reason, verify instead via the `Set-Cookie` response header in the Network tab for the `/api/login` request, and confirm the `HttpOnly` and `SameSite=Lax` attributes are present there).

With the cookie present, re-run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4321/api/restaurants -H "Cookie: ota_session=<paste the cookie value>"
```

Expected: `200` (unblocked now that a valid session exists).

Then call logout and confirm the gate re-closes:

```bash
curl -s -X POST http://localhost:4321/api/logout -H "Cookie: ota_session=<paste the cookie value>" -i
```

Expected: `204`, response includes a `Set-Cookie` header clearing `ota_session`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/login.astro src/pages/api/login.ts src/pages/api/logout.ts src/pages/index.astro
git commit -m "Add login/logout flow"
```

---

### Task 6: Reservations list + create proxy routes

**Files:**
- Create: `src/pages/api/restaurants/[id]/reservations/index.ts`

**Interfaces:**
- Consumes: `otaRequest` (Task 2).
- Produces: `GET /api/restaurants/:id/reservations?date=`, `POST /api/restaurants/:id/reservations` — consumed by Task 8 (SSR list) and Task 9 (client island).

- [ ] **Step 1: Write the route**

`src/pages/api/restaurants/[id]/reservations/index.ts`:

```ts
import type { APIRoute } from 'astro';
import { otaRequest } from '../../../../../lib/ota-client';

export const GET: APIRoute = async ({ params, url }) => {
  const date = url.searchParams.get('date');
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const { status, data } = await otaRequest(
    `/api/restaurant/${params.id}/reservations${qs}`,
    { useApiKey: true }
  );
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ params, request }) => {
  const body = await request.json().catch(() => null);
  if (!body) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { status, data } = await otaRequest(
    `/api/restaurant/${params.id}/reservations`,
    { method: 'POST', body, useApiKey: true }
  );
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};
```

- [ ] **Step 2: Verify against the real OTA API**

Log in first (via the browser, per Task 5) and grab the `ota_session` cookie value. Use the restaurant `id` noted in Task 2.

List (use today's date or any date — an empty array is a valid, correct response):

```bash
curl -s "http://localhost:4321/api/restaurants/<restaurant_id>/reservations?date=2026-08-10" -H "Cookie: ota_session=<cookie value>"
```

Expected: `200`, a JSON array (possibly empty).

Create:

```bash
curl -s -X POST "http://localhost:4321/api/restaurants/<restaurant_id>/reservations" \
  -H "Cookie: ota_session=<cookie value>" \
  -H "Content-Type: application/json" \
  -d '{"reservation_date":"2026-08-10","start_time":"19:00","party_size":2,"contact_name":"Plan Verification"}'
```

Expected: `201`, the created reservation JSON (including an assigned `table_id`). Re-run the list command above — the new reservation now appears.

- [ ] **Step 3: Commit**

```bash
git add "src/pages/api/restaurants/[id]/reservations/index.ts"
git commit -m "Add reservations list and create proxy routes"
```

---

### Task 7: Reservation update proxy route

**Files:**
- Create: `src/pages/api/restaurants/[id]/reservations/[resId].ts`

**Interfaces:**
- Consumes: `otaRequest` (Task 2).
- Produces: `PATCH /api/restaurants/:id/reservations/:resId` — consumed by Task 9 (cancel/edit actions).

- [ ] **Step 1: Write the route**

`src/pages/api/restaurants/[id]/reservations/[resId].ts`:

```ts
import type { APIRoute } from 'astro';
import { otaRequest } from '../../../../../lib/ota-client';

export const PATCH: APIRoute = async ({ params, request }) => {
  const body = await request.json().catch(() => null);
  if (!body) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { status, data } = await otaRequest(
    `/api/restaurant/${params.id}/reservations/${params.resId}`,
    { method: 'PUT', body, useApiKey: true }
  );
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};
```

- [ ] **Step 2: Verify against the real OTA API**

Using the reservation created in Task 6's verification (`<reservation_id>` from that response):

```bash
curl -s -X PATCH "http://localhost:4321/api/restaurants/<restaurant_id>/reservations/<reservation_id>" \
  -H "Cookie: ota_session=<cookie value>" \
  -H "Content-Type: application/json" \
  -d '{"status":"cancelled"}'
```

Expected: `200`, response shows `"status":"cancelled"`. Re-run the list command from Task 6 — the reservation now shows `cancelled`.

- [ ] **Step 3: Commit**

```bash
git add "src/pages/api/restaurants/[id]/reservations/[resId].ts"
git commit -m "Add reservation update proxy route"
```

---

### Task 8: Reservations page (server-rendered shell)

**Files:**
- Create: `src/pages/reservations.astro`

**Interfaces:**
- Consumes: `otaRequest` (Task 2, directly — not via the app's own `/api/*` routes, to avoid an unnecessary self-HTTP-call on first render).
- Produces: a working, view-only page reachable at `/reservations`, navigable via `?restaurant_id=&date=` query params. Task 9 layers client-side interactivity on top without changing this page's URL contract.

- [ ] **Step 1: Write the page**

`src/pages/reservations.astro`:

```astro
---
import { otaRequest } from '../lib/ota-client';

const today = new Date().toISOString().slice(0, 10);
const { data: restaurants } = await otaRequest('/api/restaurant');

const selectedRestaurantId = Astro.url.searchParams.get('restaurant_id') || restaurants?.[0]?.id || '';
const selectedDate = Astro.url.searchParams.get('date') || today;

let reservations: any[] = [];
if (selectedRestaurantId) {
  const { data } = await otaRequest(
    `/api/restaurant/${selectedRestaurantId}/reservations?date=${selectedDate}`,
    { useApiKey: true }
  );
  reservations = Array.isArray(data) ? data : [];
}
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Table Bookings</title>
  </head>
  <body>
    <h1>Table Bookings</h1>
    <form method="POST" action="/api/logout" id="logout-form">
      <button type="submit">Log out</button>
    </form>

    <form method="GET" action="/reservations">
      <label>
        Restaurant
        <select name="restaurant_id">
          {restaurants.map((r: any) => (
            <option value={r.id} selected={r.id === selectedRestaurantId}>{r.name}</option>
          ))}
        </select>
      </label>
      <label>
        Date
        <input type="date" name="date" value={selectedDate} />
      </label>
      <button type="submit">View</button>
    </form>

    <table id="reservations-table">
      <thead>
        <tr><th>Time</th><th>Table</th><th>Party</th><th>Contact</th><th>Notes</th><th>Status</th></tr>
      </thead>
      <tbody id="reservations-body">
        {reservations.map((r: any) => (
          <tr data-id={r.id}>
            <td>{r.start_time?.slice(0, 5)}</td>
            <td>{r.table_number}</td>
            <td>{r.party_size}</td>
            <td class="contact">{r.contact_name}</td>
            <td class="notes">{r.notes ?? ''}</td>
            <td class="status">{r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </body>
</html>
```

- [ ] **Step 2: Verify view-only rendering**

```bash
npm run dev
```

In a browser, log in, land on `/reservations`. Expected: the restaurant dropdown lists the real restaurants (from Task 2's data), the table shows reservations for the default restaurant/today's date (compare against the `curl` output from Task 6). Change the restaurant/date and click "View" — the page reloads with the new selection reflected in the URL (`?restaurant_id=...&date=...`) and the table updates accordingly. Click "Log out" — redirected to `/login`, and `/reservations` now redirects there too.

- [ ] **Step 3: Commit**

```bash
git add src/pages/reservations.astro
git commit -m "Add server-rendered reservations page"
```

---

### Task 9: Client-side interactivity (create, cancel, edit, no-reload refresh)

**Files:**
- Modify: `src/pages/reservations.astro`

**Interfaces:**
- Consumes: `GET/POST /api/restaurants/:id/reservations` (Task 6), `PATCH /api/restaurants/:id/reservations/:resId` (Task 7).
- Produces: the finished v1 UI — no further tasks depend on this one.

- [ ] **Step 1: Add the new-reservation form and edit affordance to the markup**

In `src/pages/reservations.astro`, replace the `<table>` block and everything after it with:

```astro
    <table id="reservations-table">
      <thead>
        <tr><th>Time</th><th>Table</th><th>Party</th><th>Contact</th><th>Notes</th><th>Status</th><th>Actions</th></tr>
      </thead>
      <tbody id="reservations-body">
        {reservations.map((r: any) => (
          <tr data-id={r.id}>
            <td>{r.start_time?.slice(0, 5)}</td>
            <td>{r.table_number}</td>
            <td>{r.party_size}</td>
            <td class="contact">{r.contact_name}</td>
            <td class="notes">{r.notes ?? ''}</td>
            <td class="status">{r.status}</td>
            <td class="actions">
              <button class="edit-btn" data-id={r.id}>Edit</button>
              <button class="cancel-btn" data-id={r.id} disabled={r.status === 'cancelled'}>Cancel</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    <h2>New reservation</h2>
    <form id="new-reservation-form">
      <input type="hidden" name="restaurant_id" value={selectedRestaurantId} />
      <label>Date <input type="date" name="reservation_date" required value={selectedDate} /></label>
      <label>Time <input type="time" name="start_time" required /></label>
      <label>Party size <input type="number" name="party_size" min="1" required /></label>
      <label>Contact name <input type="text" name="contact_name" required /></label>
      <label>Email <input type="email" name="contact_email" /></label>
      <label>Phone <input type="text" name="contact_phone" /></label>
      <label>Location <input type="text" name="location" /></label>
      <label>Notes <input type="text" name="notes" /></label>
      <button type="submit">Create</button>
      <p id="new-reservation-error" style="color:red" hidden></p>
    </form>

    <script src="../scripts/reservations-client.ts"></script>
  </body>
</html>
```

Note: this must be a relative path (`../scripts/...`), not `/src/scripts/...` — a leading-slash path resolves against `public/` in Astro/Vite and would be served as a static, untranspiled file instead of being bundled by Vite (which is what strips the TypeScript syntax below).

- [ ] **Step 2: Write the client island script**

Create `src/scripts/reservations-client.ts`:

```ts
async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  return res;
}

function currentRestaurantId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('restaurant_id') ?? (document.querySelector('select[name="restaurant_id"]') as HTMLSelectElement)?.value ?? '';
}

function actionsHtml(id: string, cancelled: boolean): string {
  return `
    <button class="edit-btn" data-id="${id}">Edit</button>
    <button class="cancel-btn" data-id="${id}" ${cancelled ? 'disabled' : ''}>Cancel</button>
  `;
}

function wireRowActions(row: HTMLTableRowElement) {
  const editBtn = row.querySelector('.edit-btn') as HTMLButtonElement | null;
  const cancelBtn = row.querySelector('.cancel-btn') as HTMLButtonElement | null;
  if (editBtn) wireEditButton(editBtn);
  if (cancelBtn) wireCancelButton(cancelBtn);
}

function addRow(r: any) {
  const tbody = document.getElementById('reservations-body')!;
  const tr = document.createElement('tr');
  tr.dataset.id = r.id;
  tr.innerHTML = `
    <td>${(r.start_time ?? '').slice(0, 5)}</td>
    <td>${r.table_number ?? ''}</td>
    <td>${r.party_size}</td>
    <td class="contact">${r.contact_name}</td>
    <td class="notes">${r.notes ?? ''}</td>
    <td class="status">${r.status}</td>
    <td class="actions">${actionsHtml(r.id, r.status === 'cancelled')}</td>
  `;
  tbody.appendChild(tr);
  wireRowActions(tr);
}

function showRowError(actionsCell: HTMLTableCellElement, message: string) {
  let errorEl = actionsCell.querySelector('.row-error') as HTMLElement | null;
  if (!errorEl) {
    errorEl = document.createElement('span');
    errorEl.className = 'row-error';
    errorEl.style.color = 'red';
    actionsCell.appendChild(errorEl);
  }
  errorEl.textContent = message;
}

function wireCancelButton(btn: HTMLButtonElement) {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.id!;
    const restaurantId = currentRestaurantId();
    const actionsCell = btn.closest('td') as HTMLTableCellElement;
    const res = await apiFetch(`/api/restaurants/${restaurantId}/reservations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showRowError(actionsCell, data?.error ?? 'Failed to cancel reservation');
      return;
    }
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const statusCell = row?.querySelector('.status');
    if (statusCell) statusCell.textContent = 'cancelled';
    btn.disabled = true;
  });
}

function wireEditButton(btn: HTMLButtonElement) {
  btn.addEventListener('click', () => {
    const id = btn.dataset.id!;
    const row = document.querySelector(`tr[data-id="${id}"]`) as HTMLTableRowElement;
    const contactCell = row.querySelector('.contact') as HTMLTableCellElement;
    const notesCell = row.querySelector('.notes') as HTMLTableCellElement;
    const actionsCell = row.querySelector('.actions') as HTMLTableCellElement;
    const originalContact = contactCell.textContent ?? '';
    const originalNotes = notesCell.textContent ?? '';

    contactCell.innerHTML = `<input type="text" class="edit-contact" value="${originalContact}" />`;
    notesCell.innerHTML = `<input type="text" class="edit-notes" value="${originalNotes}" />`;
    actionsCell.innerHTML = `
      <button class="save-btn" data-id="${id}">Save</button>
      <button class="discard-btn" data-id="${id}">Discard</button>
    `;

    (actionsCell.querySelector('.save-btn') as HTMLButtonElement).addEventListener('click', async () => {
      const newContact = (contactCell.querySelector('.edit-contact') as HTMLInputElement).value;
      const newNotes = (notesCell.querySelector('.edit-notes') as HTMLInputElement).value;
      const restaurantId = currentRestaurantId();
      const res = await apiFetch(`/api/restaurants/${restaurantId}/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ contact_name: newContact, notes: newNotes }),
      });
      const updated = await res.json().catch(() => null);
      if (!res.ok) {
        showRowError(actionsCell, updated?.error ?? 'Failed to save changes');
        return;
      }
      contactCell.textContent = updated.contact_name;
      notesCell.textContent = updated.notes ?? '';
      actionsCell.innerHTML = actionsHtml(id, updated.status === 'cancelled');
      wireRowActions(row);
    });

    (actionsCell.querySelector('.discard-btn') as HTMLButtonElement).addEventListener('click', () => {
      contactCell.textContent = originalContact;
      notesCell.textContent = originalNotes;
      const statusCell = row.querySelector('.status');
      actionsCell.innerHTML = actionsHtml(id, statusCell?.textContent === 'cancelled');
      wireRowActions(row);
    });
  });
}

document.querySelectorAll<HTMLTableRowElement>('#reservations-body tr').forEach(wireRowActions);

const newForm = document.getElementById('new-reservation-form') as HTMLFormElement;
const newFormError = document.getElementById('new-reservation-error') as HTMLParagraphElement;

newForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  newFormError.hidden = true;
  const formData = new FormData(newForm);
  const restaurantId = formData.get('restaurant_id') as string;
  const body: Record<string, unknown> = {
    reservation_date: formData.get('reservation_date'),
    start_time: formData.get('start_time'),
    party_size: Number(formData.get('party_size')),
    contact_name: formData.get('contact_name'),
  };
  for (const key of ['contact_email', 'contact_phone', 'location', 'notes'] as const) {
    const value = formData.get(key);
    if (value) body[key] = value;
  }

  const res = await apiFetch(`/api/restaurants/${restaurantId}/reservations`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    newFormError.textContent = data?.error ?? 'Failed to create reservation';
    newFormError.hidden = false;
    return;
  }
  addRow(data);
  newForm.reset();
});
```

- [ ] **Step 3: Verify no-reload interactivity in the browser**

```bash
npm run dev
```

Log in, land on `/reservations`. Fill out and submit the "New reservation" form with a time/date known to have availability — expected: a new row appears in the table immediately, no page reload (confirm via the browser's network tab: an XHR/fetch to `/api/restaurants/.../reservations`, not a full navigation).

Click "Edit" on that row — expected: the Contact and Notes cells become text inputs pre-filled with the current values, and the actions cell shows "Save"/"Discard" instead of "Edit"/"Cancel". Change both values and click "Save" — expected: the cells revert to plain text showing the new values, the actions cell shows "Edit"/"Cancel" again, no page reload. Click "Edit" again, change a value, then click "Discard" — expected: the cells revert to the *original* (pre-edit) values, not the changed ones.

Click "Cancel" on the row — expected: the status cell updates to `cancelled` and the Cancel button disables, again with no page reload.

Trigger a validation error deliberately (e.g. a `start_time` outside service hours, from `docs/superpowers/specs/2026-07-19-restaurant-service-periods-design.md` in the `OTA` repo for what counts as service hours) — expected: the inline error message appears under the new-reservation form, the form's entered values are preserved (not cleared), and no row is added.

Clear the `ota_session` cookie via devtools, then click "Cancel" on any row — expected: redirected to `/login` (confirms the client fetch wrapper's 401 handling).

(Cancel/Save failures follow the same `showRowError` path already exercised structurally by the create-form error case above and the `502` proxy behavior verified in Task 2 — no separate contrived repro needed here.)

- [ ] **Step 4: Commit**

```bash
git add src/pages/reservations.astro src/scripts/reservations-client.ts
git commit -m "Add client-side interactivity for create/cancel/edit and no-reload refresh"
```

---

### Task 10: Deploy to Vercel and verify end-to-end in production

**Files:** none (infrastructure/deployment task)

**Interfaces:** none — this is the final task.

- [ ] **Step 1: Push the repo to GitHub**

Create a new GitHub repository (e.g. `ota-table-bookings`) and push:

```bash
git remote add origin <the new GitHub repo URL>
git push -u origin main
```

- [ ] **Step 2: Import the project into Vercel**

In the Vercel dashboard: "Add New Project" → import the `ota-table-bookings` GitHub repo. Vercel auto-detects Astro via the `@astrojs/vercel` adapter — accept the default build settings.

- [ ] **Step 3: Set environment variables in Vercel**

In the Vercel project's Settings → Environment Variables, add for the Production environment:

- `OTA_API_BASE_URL` = `https://ota-u6ii.onrender.com`
- `OTA_API_KEY` = (the same value used in local `.env`)

Redeploy after adding them (Vercel prompts for this automatically, or trigger a redeploy manually from the Deployments tab).

- [ ] **Step 4: Verify in production**

Visit the deployed Vercel URL. Repeat the manual checks from Tasks 5, 8, and 9 against it: log in with a real `api_user` account, view reservations for a real restaurant/date, create one, cancel it. Confirm via the OTA API directly (`curl https://ota-u6ii.onrender.com/api/restaurant/<id>/reservations?date=...` with the real `X-Api-Key`) that the created/cancelled reservation is visible there too — proving the deployed app is really talking to the live OTA API and not some stale/cached state.

Open the deployed page's Network tab one more time and confirm: every request the browser makes goes to the Vercel deployment's own domain (`/api/...`), never directly to `ota-u6ii.onrender.com`, and `OTA_API_KEY`'s value doesn't appear anywhere in any request or response the browser can see.

- [ ] **Step 5: Commit any final adjustments**

If Step 3/4 required any code changes (e.g. a build setting fix), commit them:

```bash
git add -A
git commit -m "Fix production deployment configuration"
git push
```
