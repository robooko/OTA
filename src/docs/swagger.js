const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Hotel PMS API',
    version: '1.0.0',
    description: 'Property Management System API — rooms, restaurants, spa, beach club, tours, equipment hire, and golf.',
  },
  servers: [
    { url: 'https://ota-u6ii.onrender.com', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local' },
  ],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Auth' },
    { name: 'Property' },
    { name: 'Guests' },
    { name: 'Room Types' },
    { name: 'Rooms' },
    { name: 'Availability' },
    { name: 'Bookings' },
    { name: 'Payments' },
    { name: 'Restaurant' },
    { name: 'Spa' },
    { name: 'Beach Club' },
    { name: 'Tours' },
    { name: 'Equipment' },
    { name: 'Golf' },
    { name: 'Extras' },
    { name: 'Room Service' },
    { name: 'Pro Shop' },
    { name: 'Event Inquiries' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'A Clerk session token for a user with an active Organization (maps to a property). Not this API\'s own token — Clerk issues and verifies it.',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'string' },
        },
      },
      Guest: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      RoomType: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string' },
          max_occupancy: { type: 'integer' },
          base_rate: { type: 'number' },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
      },
      Room: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          room_type_id: { type: 'string', format: 'uuid' },
          room_number: { type: 'string' },
          floor: { type: 'integer' },
          status: { type: 'string', enum: ['active', 'maintenance', 'inactive'] },
        },
      },
      Booking: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          guest_id: { type: 'string', format: 'uuid' },
          room_id: { type: 'string', format: 'uuid' },
          check_in: { type: 'string', format: 'date' },
          check_out: { type: 'string', format: 'date' },
          guests: { type: 'integer' },
          total_price: { type: 'number' },
          status: { type: 'string', enum: ['confirmed', 'cancelled', 'checked_in', 'checked_out'] },
          created_at: { type: 'string', format: 'date-time' },
          extras: { type: 'array', items: { $ref: '#/components/schemas/BookingExtra' } },
        },
      },
      Extra: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string' },
          price: { type: 'number' },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
      },
      RestaurantMenuItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          restaurant_id: { type: 'string', format: 'uuid', nullable: true, description: 'Optional — which of the property\'s restaurants this menu item belongs to' },
          name: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string' },
          price: { type: 'number' },
          allergens: { type: 'array', items: { type: 'string' }, description: 'Free-form, property-wide list (not a fixed taxonomy) — e.g. ["Gluten", "Milk"]' },
          variants: { type: 'array', items: { type: 'string' }, description: 'Free-form, property-wide list (not a fixed taxonomy) — e.g. ["Small", "Large"], ["Mild", "Hot"]' },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
      },
      RestaurantOrderItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          item_id: { type: 'string', format: 'uuid' },
          item_name: { type: 'string' },
          quantity: { type: 'integer' },
          unit_price: { type: 'number' },
          total: { type: 'number' },
        },
      },
      RestaurantOrder: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          restaurant_id: { type: 'string', format: 'uuid' },
          booking_id: { type: 'string', format: 'uuid', nullable: true, description: 'Set when the order is delivered to a hotel room' },
          table_id: { type: 'string', format: 'uuid', nullable: true, description: 'Set when the order is served at a restaurant table' },
          guest_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'] },
          notes: { type: 'string' },
          total_price: { type: 'number' },
          scheduled_for: { type: 'string', format: 'date-time', description: 'Optional delivery time e.g. 07:30 next morning' },
          created_at: { type: 'string', format: 'date-time' },
          items: { type: 'array', items: { $ref: '#/components/schemas/RestaurantOrderItem' } },
        },
      },
      BookingExtra: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          extra_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string' },
          quantity: { type: 'integer' },
          unit_price: { type: 'number' },
          total: { type: 'number' },
        },
      },
    },
  },
  paths: {
    // ── Auth ────────────────────────────────────────────────────────────────
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Get the current property and role, resolved from the Clerk session token', responses: { 200: { description: 'Object with property_id and role', content: { 'application/json': { schema: { type: 'object', properties: { property_id: { type: 'string', format: 'uuid' }, role: { type: 'string', enum: ['admin', 'staff'] } } } } } } } },
    },

    // ── Property ────────────────────────────────────────────────────────────
    '/api/property/me': {
      get: { tags: ['Property'], summary: 'Get the current property (id, name, currency, timezone)', responses: { 200: { description: 'Property identity', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, currency: { type: 'string' }, timezone: { type: 'string' } } } } } } } },
      put: { tags: ['Property'], summary: 'Update the current property (admin only)', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { currency: { type: 'string', description: '3-letter ISO 4217 code, e.g. GBP' }, timezone: { type: 'string', description: 'IANA timezone name, e.g. Europe/London' } } } } } }, responses: { 200: { description: 'Updated' }, 400: { description: 'Invalid currency or timezone format' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key': {
      get: { tags: ['Property'], summary: "Get the current property's API key (admin only)", responses: { 200: { description: 'API key and enabled state', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' }, api_key_enabled: { type: 'boolean' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/rotate': {
      post: { tags: ['Property'], summary: "Rotate the current property's API key (admin only) — the old key stops working immediately", responses: { 200: { description: 'New API key', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/disable': {
      post: { tags: ['Property'], summary: "Disable the current property's API key without rotating it (admin only)", responses: { 200: { description: 'Current key and enabled state (false)', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' }, api_key_enabled: { type: 'boolean' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/api-key/enable': {
      post: { tags: ['Property'], summary: "Re-enable the current property's API key (admin only) — restores access using the same key value", responses: { 200: { description: 'Current key and enabled state (true)', content: { 'application/json': { schema: { type: 'object', properties: { api_key: { type: 'string' }, api_key_enabled: { type: 'boolean' } } } } } }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/vercel/projects': {
      get: { tags: ['Property'], summary: "List the connected Vercel account's projects (id, name) for the website-mapping picker", responses: { 200: { description: 'Array of { id, name }' }, 503: { description: 'Server not configured with VERCEL_TOKEN' } } },
    },
    '/api/property/vercel/projects/{projectId}/analytics': {
      get: { tags: ['Property'], summary: "Get a Vercel project's Web Analytics directly by project ID, without a property_website mapping", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'since', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Defaults to 30 days before until' }, { name: 'until', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Defaults to today' }], responses: { 200: { description: 'visitors, pageviews, and a daily breakdown' }, 400: { description: 'Invalid date' }, 502: { description: 'Vercel API request failed' }, 503: { description: 'Server not configured with VERCEL_TOKEN' } } },
    },
    '/api/property/vercel/connect': {
      get: { tags: ['Property'], summary: 'Get the URL to start the Vercel Integration install flow for the current property', responses: { 200: { description: '{ url }' } } },
    },
    '/api/property/vercel/status': {
      get: { tags: ['Property'], summary: "Whether the current property has completed the Vercel Integration install flow, and whether an analytics-capable PAT is configured (note: install-flow connection tracks installation status only -- installation tokens can't read Web Analytics)", responses: { 200: { description: '{ connected, teamId, connectedAt, analyticsPatConfigured }' } } },
    },
    '/api/property/vercel/disconnect': {
      post: { tags: ['Property'], summary: 'Clear the stored Vercel connection status for the current property', responses: { 200: { description: '{ connected: false }' } } },
    },
    '/api/property/vercel/pat': {
      put: { tags: ['Property'], summary: "Set the current property's Vercel Personal Access Token, used for Web Analytics (admin only) -- unlike the OAuth install flow, a PAT can actually read Web Analytics", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['vercel_pat'], properties: { vercel_pat: { type: 'string' }, vercel_team_id: { type: 'string', description: 'Optional -- overrides the stored team ID if the PAT belongs to a different team' } } } } } }, responses: { 200: { description: '{ analyticsPatConfigured: true }' }, 400: { description: 'Missing vercel_pat' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/vercel/pat/clear': {
      post: { tags: ['Property'], summary: "Clear the current property's Vercel Personal Access Token (admin only)", security: [{ bearerAuth: [] }], responses: { 200: { description: '{ analyticsPatConfigured: false }' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/stripe/status': {
      get: { tags: ['Property'], summary: "Whether the current property has a Stripe secret key configured", description: 'The key itself is never returned -- only a configured boolean.', security: [{ bearerAuth: [] }], responses: { 200: { description: '{ stripeKeyConfigured: boolean }' } } },
    },
    '/api/property/stripe/key': {
      put: { tags: ['Property'], summary: "Set the current property's Stripe secret key (admin only)", description: 'Used to create reservation deposits/holds and settle table sessions under the property\'s own Stripe account.', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['stripe_secret_key'], properties: { stripe_secret_key: { type: 'string' } } } } } }, responses: { 200: { description: '{ stripeKeyConfigured: true }' }, 400: { description: 'Missing stripe_secret_key' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/stripe/key/clear': {
      post: { tags: ['Property'], summary: "Clear the current property's Stripe secret key (admin only)", security: [{ bearerAuth: [] }], responses: { 200: { description: '{ stripeKeyConfigured: false }' }, 403: { description: 'Insufficient permissions' } } },
    },
    '/api/property/websites': {
      get: { tags: ['Property'], summary: "List the current property's websites", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: 'Array of websites' } } },
      post: { tags: ['Property'], summary: 'Add a website to the current property', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', example: 'https://bonito-eta.vercel.app' }, label: { type: 'string', example: 'Bonito' }, vercel_project_id: { type: 'string', description: 'Vercel project ID, enables the analytics endpoint below' } } } } } }, responses: { 201: { description: 'Created' }, 400: { description: 'Missing or invalid url' } } },
    },
    '/api/property/websites/{id}': {
      put: { tags: ['Property'], summary: 'Update a website (url, label, status, or vercel_project_id)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] }, vercel_project_id: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Website not found' } } },
    },
    '/api/property/websites/{id}/analytics': {
      get: { tags: ['Property'], summary: "Get a website's Vercel Web Analytics (requires vercel_project_id to be set)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'since', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Defaults to 30 days before until' }, { name: 'until', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Defaults to today' }], responses: { 200: { description: 'visitors, pageviews, and a daily breakdown' }, 400: { description: 'Website not mapped to a Vercel project, or invalid date' }, 404: { description: 'Website not found' }, 502: { description: 'Vercel API request failed' }, 503: { description: 'Server not configured with VERCEL_TOKEN' } } },
    },

    // ── Guests ──────────────────────────────────────────────────────────────
    '/api/guests': {
      get: {
        tags: ['Guests'],
        summary: 'List all guests',
        responses: { 200: { description: 'Array of guests' } },
      },
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
                  property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Guest created' } },
      },
    },
    '/api/guests/lookup': {
      get: { tags: ['Guests'], summary: 'Look up guest by email', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } }, { name: 'property_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' }], responses: { 200: { description: 'Guest found' }, 404: { description: 'Guest not found' } } },
    },
    '/api/guests/{id}': {
      get: { tags: ['Guests'], summary: 'Get guest by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Guest' }, 404: { description: 'Not found' } } },
      put: { tags: ['Guests'], summary: 'Update guest', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated guest' } } },
      delete: { tags: ['Guests'], summary: 'Delete guest', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Deleted' } } },
    },
    '/api/guests/{id}/summary': {
      get: { tags: ['Guests'], summary: "Guest lifetime stats", description: 'Aggregates across all of the guest\'s room bookings: total_stays, total_spent, avg_nights, total_nights, last_stay, confirmed/cancelled counts, and total_extras_spent.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Summary stats object' }, 404: { description: 'Guest not found' } } },
    },

    // ── Room Types ───────────────────────────────────────────────────────────
    '/api/room-types': {
      get: { tags: ['Room Types'], summary: 'List all room types', responses: { 200: { description: 'Array of room types' } } },
      post: { tags: ['Room Types'], summary: 'Create room type', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'max_occupancy', 'base_rate'], properties: { name: { type: 'string' }, description: { type: 'string' }, max_occupancy: { type: 'integer' }, base_rate: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/room-types/{id}': {
      get: { tags: ['Room Types'], summary: 'Get room type by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Room type' } } },
      put: { tags: ['Room Types'], summary: 'Update room type', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, max_occupancy: { type: 'integer' }, base_rate: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] }, floor_plan: { type: 'object' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
    '/api/room-types/{id}/rates': {
      get: { tags: ['Room Types'], summary: 'List dated nightly rates for a room type (dates without a row fall back to base_rate)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Exclusive' }], responses: { 200: { description: 'Array of dated rates' }, 404: { description: 'Not found' } } },
      put: { tags: ['Room Types'], summary: 'Bulk set dated rates over ranges — to is exclusive; rate: null clears the range back to base_rate. Per-room override_rate still wins.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['rates'], properties: { rates: { type: 'array', items: { type: 'object', required: ['from', 'to', 'rate'], properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date', description: 'Exclusive' }, rate: { type: 'number', nullable: true } } } } } } } } }, responses: { 200: { description: '{ upserted, deleted } row counts' }, 400: { description: 'Validation failure' } } },
    },

    // ── Rooms ────────────────────────────────────────────────────────────────
    '/api/rooms': {
      get: { tags: ['Rooms'], summary: 'List all rooms', parameters: [{ name: 'room_type_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of rooms' } } },
      post: { tags: ['Rooms'], summary: 'Create room', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['room_type_id', 'room_number'], properties: { room_type_id: { type: 'string', format: 'uuid' }, room_number: { type: 'string' }, floor: { type: 'integer' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/rooms/{id}': {
      get: { tags: ['Rooms'], summary: 'Get room by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Room' } } },
      put: { tags: ['Rooms'], summary: 'Update room', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { room_number: { type: 'string' }, floor: { type: 'integer' }, status: { type: 'string', enum: ['active', 'maintenance', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' } } },
    },

    // ── Availability ─────────────────────────────────────────────────────────
    '/api/availability/search': {
      get: { tags: ['Availability'], summary: 'Search available room types (public)', security: [], parameters: [{ name: 'check_in', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'check_out', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'guests', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'property_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Available room types with rates' } } },
    },
    '/api/availability/rooms/{room_id}': {
      get: { tags: ['Availability'], summary: 'Get availability for a room', parameters: [{ name: 'room_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'Availability records' } } },
      put: { tags: ['Availability'], summary: 'Bulk upsert availability for a room', parameters: [{ name: 'room_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['dates'], properties: { dates: { type: 'array', items: { type: 'object', properties: { date: { type: 'string', format: 'date' }, is_available: { type: 'boolean' }, override_rate: { type: 'number' }, block_reason: { type: 'string' } } } } } } } } }, responses: { 200: { description: 'Updated records' } } },
    },
    '/api/availability/overrides': {
      get: { tags: ['Availability'], summary: 'List all override rates', parameters: [{ name: 'room_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'Override records with room and rate info' } } },
    },
    '/api/availability/overrides/{id}': {
      delete: { tags: ['Availability'], summary: 'Delete an availability override', description: 'Removes the room_availability row (the night falls back to open at the room-type rate).', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Deleted record' }, 404: { description: 'Availability record not found' } } },
    },
    '/api/availability/types': {
      get: { tags: ['Availability'], summary: 'Get room type availability summary', parameters: [{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'room_type_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Summary from materialized view' } } },
    },
    '/api/availability/refresh': {
      post: { tags: ['Availability'], summary: 'Refresh materialized view', responses: { 200: { description: 'View refreshed' } } },
    },

    // ── Bookings ─────────────────────────────────────────────────────────────
    '/api/bookings': {
      get: { tags: ['Bookings'], summary: 'List bookings', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Bookings'], summary: 'Create booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid', description: 'Exactly one of room_id or room_type_id is required.' }, room_type_id: { type: 'string', format: 'uuid', description: 'Alternative to room_id: books the first available room of this type. Exactly one of room_id or room_type_id is required.' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'InterContinental Le Moana Bora Bora Resort' } }, property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room (or room type) not available' } } },
    },
    '/api/bookings/{id}': {
      get: { tags: ['Bookings'], summary: 'Get booking by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Booking with guest and room details' } } },
      put: { tags: ['Bookings'], summary: 'Update booking', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['confirmed', 'cancelled', 'checked_in', 'checked_out'] }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'Conrad Base' } } } } } } }, responses: { 200: { description: 'Updated' } } },
      delete: { tags: ['Bookings'], summary: 'Cancel booking — restores availability', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Cancelled' } } },
    },

    // ── Payments ─────────────────────────────────────────────────────────────
    '/api/payments/booking/{booking_id}': {
      get: { tags: ['Payments'], summary: 'List payments for a booking', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of payments' } } },
    },
    '/api/payments': {
      post: { tags: ['Payments'], summary: 'Record a payment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['booking_id', 'amount', 'method'], properties: { booking_id: { type: 'string', format: 'uuid' }, amount: { type: 'number' }, method: { type: 'string', enum: ['card', 'cash', 'bank_transfer'] } } } } } }, responses: { 201: { description: 'Payment recorded' } } },
    },
    '/api/payments/{id}': {
      put: { tags: ['Payments'], summary: 'Update payment status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'completed', 'refunded'] } } } } } }, responses: { 200: { description: 'Updated' } } },
    },

    // ── Restaurant ───────────────────────────────────────────────────────────
    '/api/restaurant': {
      get: { tags: ['Restaurant'], summary: 'List all restaurants', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: 'Array of restaurants' } } },
      post: { tags: ['Restaurant'], summary: 'Create restaurant', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'default_duration_minutes'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer', example: 15 }, default_duration_minutes: { type: 'integer', example: 90 }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [7] }, currency: { type: 'string', description: 'ISO 4217 code, e.g. GBP. Omit to inherit the property\'s currency' }, timezone: { type: 'string', description: 'IANA timezone name, e.g. Europe/London. Omit to inherit the property\'s timezone' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/reservations': {
      get: { tags: ['Restaurant'], summary: "List reservations across all of the property's restaurants", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of reservations, each including restaurant_id' } } },
    },
    '/api/restaurant/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get restaurant by ID', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Restaurant' } } },
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, slot_interval_minutes: { type: 'integer' }, default_duration_minutes: { type: 'integer' }, closed_days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, example: [1, 7] }, status: { type: 'string', enum: ['active', 'inactive'] }, currency: { type: 'string', description: 'ISO 4217 code, e.g. GBP. Omit to leave unchanged' }, timezone: { type: 'string', description: 'IANA timezone name, e.g. Europe/London. Omit to leave unchanged' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
    '/api/restaurant/{restaurant_id}/tables': {
      get: { tags: ['Restaurant'], summary: 'List tables', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of tables' } } },
      post: { tags: ['Restaurant'], summary: 'Create table', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_number', 'seats'], properties: { table_number: { type: 'string' }, seats: { type: 'integer' }, location: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{restaurant_id}/tables/{id}': {
      put: { tags: ['Restaurant'], summary: 'Update table', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { table_number: { type: 'string' }, seats: { type: 'integer' }, location: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Table not found' } } },
    },
    '/api/restaurant/{restaurant_id}/service-periods': {
      get: { tags: ['Restaurant'], summary: "List a restaurant's service periods (bookable windows)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of service periods' }, 404: { description: 'Restaurant not found' } } },
      put: { tags: ['Restaurant'], summary: "Replace all of a restaurant's service periods", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['periods'], properties: { periods: { type: 'array', items: { type: 'object', required: ['start_time', 'end_time'], properties: { label: { type: 'string', nullable: true, example: 'Lunch' }, start_time: { type: 'string', example: '11:30' }, end_time: { type: 'string', example: '14:30' } } } } } } } } }, responses: { 200: { description: 'The new array of service periods' }, 400: { description: 'Invalid periods' }, 404: { description: 'Restaurant not found' } } },
    },
    '/api/restaurant/{restaurant_id}/availability/search': {
      get: { tags: ['Restaurant'], summary: 'Search available reservation times, grouped by date and location (public)', security: [], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'party_size', in: 'query', required: true, schema: { type: 'integer' } }, { name: 'location', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of { date, slots: [{ time, location, available_tables }] }' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations': {
      get: { tags: ['Restaurant'], summary: 'List reservations', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Exact reservation_date match' }, { name: 'date_from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Inclusive range start, independent of date' }, { name: 'date_to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Inclusive range end, independent of date' }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'clerk_user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of reservations' } } },
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } }, stripe_payment_intent_id: { type: 'string', description: 'Deposit/prepayment charge this reservation is linked to, if any' }, property_id: { type: 'string', format: 'uuid', description: 'Ignored. The property is determined by which per-property X-Api-Key or Bearer token authenticated the request — this field has no effect even if sent.' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get reservation by ID', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Reservation' } } },
      put: { tags: ['Restaurant'], summary: 'Update reservation', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, metadata: { type: 'object', additionalProperties: true, example: { occasion: 'anniversary' } }, stripe_payment_intent_id: { type: 'string', description: 'Deposit/prepayment charge this reservation is linked to, if any' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations/{id}/payment-intent': {
      get: { tags: ['Restaurant'], summary: "Live Stripe status of the reservation's linked payment intent", description: "Fetches the intent from Stripe. status is the Stripe status, except a refunded charge reports 'refunded' (a refunded intent still retrieves as 'succeeded' upstream).", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: '{ payment_intent_id, status, amount, currency }' }, 404: { description: 'Reservation not found, or no payment intent linked' }, 409: { description: 'No Stripe secret key configured for this property' }, 502: { description: 'Stripe error' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations/{id}/seat': {
      post: { tags: ['Restaurant'], summary: 'Seat a reservation (opens/links its table session)', description: "Marks the reservation seated and opens a table session for its tab. table_id overrides the booked table (the whole table-change mechanism). Refuses to attach to another party's open session -- only a free table, or this reservation's own session (idempotent), can be seated.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { table_id: { type: 'string', format: 'uuid', description: "Seat at this table instead of the reservation's own" } } } } } }, responses: { 200: { description: '{ reservation, session_id, table_id }' }, 404: { description: 'Reservation or table not found' }, 409: { description: 'Reservation cancelled / already seated / table already has an active session' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations/{id}/cancel': {
      post: { tags: ['Restaurant'], summary: 'Cancel a reservation, settling its Stripe hold', description: "Sets status to cancelled and resolves any linked payment intent. payment reports what happened to the money: none (no intent), released (uncaptured hold cancelled), refunded, captured/kept (per no-show policy), or unavailable (intent linked but no Stripe key configured -- the reservation still cancels).", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: '{ reservation, payment }' }, 404: { description: 'Reservation not found' }, 409: { description: 'Reservation already cancelled' }, 502: { description: 'Stripe error' } } },
    },

    // ── Spa ──────────────────────────────────────────────────────────────────
    '/api/spa': {
      get: { tags: ['Spa'], summary: 'List all spas', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of spas' } } },
      post: { tags: ['Spa'], summary: 'Create spa', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{id}': {
      get: { tags: ['Spa'], summary: 'Get spa by ID', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Spa' } } },
      put: { tags: ['Spa'], summary: 'Update spa. Set status to "inactive" to delete it — there is no hard-delete endpoint.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
    '/api/spa/appointments': {
      get: { tags: ['Spa'], summary: 'Property-wide live spa appointments feed', description: "Newest-first across every spa, shaped for the live-bookings feed. Paginate by passing the oldest loaded appointment's created_at as cursor.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Return appointments created before this timestamp' }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 30, maximum: 100 } }], responses: { 200: { description: 'Array of live-feed appointments' } } },
    },
    '/api/spa/{spa_id}/treatments': {
      get: { tags: ['Spa'], summary: 'List treatments', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of treatments' } } },
      post: { tags: ['Spa'], summary: 'Create treatment', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{spa_id}/treatments/{id}': {
      put: { tags: ['Spa'], summary: 'Update treatment. Set status to "inactive" to delete it.', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Treatment not found' } } },
    },
    '/api/spa/{spa_id}/therapists': {
      get: { tags: ['Spa'], summary: 'List therapists', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of therapists' } } },
      post: { tags: ['Spa'], summary: 'Create therapist', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/{spa_id}/therapists/{id}': {
      put: { tags: ['Spa'], summary: 'Update therapist (e.g. activate/deactivate)', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Therapist not found' } } },
    },
    '/api/spa/{spa_id}/slots': {
      get: { tags: ['Spa'], summary: 'List slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'therapist_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of slots' } } },
    },
    '/api/spa/{spa_id}/slots/bulk': {
      post: { tags: ['Spa'], summary: 'Bulk generate spa slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['therapist_id', 'treatment_id', 'from', 'to', 'times'], properties: { therapist_id: { type: 'string', format: 'uuid' }, treatment_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' }, example: ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00'] } } } } } }, responses: { 201: { description: 'Slots created' }, 400: { description: 'therapist_id or treatment_id does not belong to this spa' } } },
    },
    '/api/spa/{spa_id}/slots/search': {
      get: { tags: ['Spa'], summary: 'Search available spa slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Available slots with therapist and treatment info' } } },
    },
    '/api/spa/{spa_id}/slots/{id}': {
      put: { tags: ['Spa'], summary: 'Update a spa slot. Set status to "inactive" to cancel/delete it.', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Slot not found' } } },
    },
    '/api/spa/{spa_id}/appointments': {
      get: { tags: ['Spa'], summary: 'List appointments', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'clerk_user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of appointments' } } },
      post: { tags: ['Spa'], summary: 'Book spa appointment', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Appointment booked' }, 409: { description: 'Slot already booked' } } },
    },
    '/api/spa/{spa_id}/appointments/{id}': {
      get: { tags: ['Spa'], summary: 'Get appointment by ID', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Appointment with therapist and treatment details' }, 404: { description: 'Appointment not found' } } },
      put: { tags: ['Spa'], summary: 'Update appointment', security: [{ bearerAuth: [] }], parameters: [{ name: 'spa_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },

    // ── Beach Club ───────────────────────────────────────────────────────────
    '/api/beach-club/beds': {
      get: { tags: ['Beach Club'], summary: 'List beds', parameters: [{ name: 'zone', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of beds' } } },
      post: { tags: ['Beach Club'], summary: 'Create bed', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['bed_number'], properties: { bed_number: { type: 'string' }, zone: { type: 'string', example: 'pool, beach, VIP' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/beach-club/beds/{id}': {
      put: { tags: ['Beach Club'], summary: 'Update bed', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { bed_number: { type: 'string' }, zone: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Bed not found' } } },
    },
    '/api/beach-club/beds/search': {
      get: { tags: ['Beach Club'], summary: 'Search available beds', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'zone', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Available beds' } } },
    },
    '/api/beach-club/bookings': {
      get: { tags: ['Beach Club'], summary: 'List beach club bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'zone', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Beach Club'], summary: 'Book a beach bed', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['bed_id', 'contact_name', 'date'], properties: { bed_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, date: { type: 'string', format: 'date' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created' }, 409: { description: 'Bed already booked' } } },
    },
    '/api/beach-club/bookings/{id}': {
      put: { tags: ['Beach Club'], summary: 'Update beach club booking (e.g. cancel)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Booking not found' } } },
    },

    // ── Tours ────────────────────────────────────────────────────────────────
    '/api/tours': {
      get: { tags: ['Tours'], summary: 'List tours', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of tours' } } },
      post: { tags: ['Tours'], summary: 'Create tour', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'max_group_size', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, max_group_size: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/tours/{id}': {
      put: { tags: ['Tours'], summary: 'Update tour. Set status to "inactive" to delete it.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, max_group_size: { type: 'integer' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Tour not found' } } },
    },
    '/api/tours/slots/{id}': {
      put: { tags: ['Tours'], summary: 'Update a tour slot. Set status to "inactive" to cancel/delete it.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 400: { description: 'status is required' }, 404: { description: 'Slot not found' } } },
    },
    '/api/tours/bookings/{id}': {
      put: { tags: ['Tours'], summary: 'Update tour booking (e.g. cancel)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Booking not found' } } },
    },
    '/api/tours/slots/bulk': {
      post: { tags: ['Tours'], summary: 'Bulk generate tour slots', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tour_id', 'from', 'to', 'times'], properties: { tour_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } } } } } } }, responses: { 201: { description: 'Slots created' }, 404: { description: 'Tour not found' } } },
    },
    '/api/tours/slots/search': {
      get: { tags: ['Tours'], summary: 'Search available tour slots', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'tour_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'group_size', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available slots with capacity info' } } },
    },
    '/api/tours/bookings': {
      get: { tags: ['Tours'], summary: 'List tour bookings', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Tours'], summary: 'Book a tour', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name', 'group_size'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, group_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 404: { description: 'Slot or guest not found' }, 409: { description: 'Not enough spots' } } },
    },

    // ── Equipment ────────────────────────────────────────────────────────────
    '/api/equipment': {
      get: { tags: ['Equipment'], summary: 'List equipment', security: [{ bearerAuth: [] }], parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of equipment' } } },
      post: { tags: ['Equipment'], summary: 'Create equipment', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'type', 'quantity'], properties: { name: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'integer' }, price_per_day: { type: 'number' }, price_per_hour: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/equipment/{id}': {
      put: { tags: ['Equipment'], summary: 'Update equipment. Set status to "inactive" to delete it.', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'integer' }, price_per_day: { type: 'number' }, price_per_hour: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Equipment not found' } } },
    },
    '/api/equipment/search': {
      get: { tags: ['Equipment'], summary: 'Search available equipment', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'quantity', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available equipment with quantities' } } },
    },
    '/api/equipment/hires': {
      get: { tags: ['Equipment'], summary: 'List hire bookings', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'golf_booking_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'equipment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of hires' } } },
      post: { tags: ['Equipment'], summary: 'Hire equipment', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['equipment_id', 'contact_name', 'hire_date', 'quantity'], properties: { equipment_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, hire_date: { type: 'string', format: 'date' }, quantity: { type: 'integer' }, notes: { type: 'string' }, rate_type: { type: 'string', enum: ['per_day', 'per_hour'], default: 'per_day' }, duration: { type: 'number', default: 1, description: 'Days or hours depending on rate_type' }, golf_booking_id: { type: 'string', format: 'uuid', description: 'Link to a golf booking' }, total_price: { type: 'number', readOnly: true, description: 'rate × quantity × duration' } } } } } }, responses: { 201: { description: 'Hire created with total_price' }, 409: { description: 'Not enough available' } } },
    },

    '/api/equipment/hires/{id}': {
      put: { tags: ['Equipment'], summary: 'Update hire booking (e.g. cancel)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Hire not found' } } },
    },

    // ── Event Inquiries ─────────────────────────────────────────────────────
    '/api/event-inquiries': {
      get: { tags: ['Event Inquiries'], summary: 'List event inquiries', responses: { 200: { description: "Array of inquiries, newest first. Each includes last_reply_direction ('inbound'/'outbound'/null) for the feed's avatar-vs-status-badge display." } } },
      post: { tags: ['Event Inquiries'], summary: 'Submit an event inquiry', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'email', 'event_date'], properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, event_date: { type: 'string', format: 'date' }, guests: { type: 'integer' }, event_type: { type: 'string' }, format: { type: 'string' }, message: { type: 'string' }, restaurant_id: { type: 'string', format: 'uuid', description: 'Optional -- must belong to this property' } } } } } }, responses: { 201: { description: 'Created' }, 400: { description: 'Missing or invalid fields' } } },
    },
    '/api/event-inquiries/{id}': {
      put: { tags: ['Event Inquiries'], summary: 'Update an inquiry\'s status or restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, restaurant_id: { type: 'string', format: 'uuid' } } } } } }, responses: { 200: { description: 'Updated' }, 400: { description: 'Invalid restaurant_id' }, 404: { description: 'Not found' } } },
    },
    '/api/event-inquiries/{id}/replies': {
      get: { tags: ['Event Inquiries'], summary: 'List an inquiry\'s reply thread', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of messages, oldest first' }, 404: { description: 'Not found' } } },
      post: { tags: ['Event Inquiries'], summary: 'Send a reply email to the guest', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' } } } } } }, responses: { 201: { description: 'Sent' }, 400: { description: 'Missing body' }, 404: { description: 'Not found' } } },
    },

    // ── Golf ─────────────────────────────────────────────────────────────────
    '/api/golf/courses': {
      get: { tags: ['Golf'], summary: 'List courses', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Array of courses' } } },
      post: { tags: ['Golf'], summary: 'Create course', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'holes', 'price_per_player'], properties: { name: { type: 'string' }, description: { type: 'string' }, holes: { type: 'integer' }, price_per_player: { type: 'number' }, first_tee: { type: 'string', example: '07:00', description: 'Tee-sheet schedule: when first_tee, last_tee, and tee_interval_minutes are all set, tee_time rows auto-generate out to a rolling ~6-month horizon (boot + daily sweep). All three unset = manual tee sheet via POST /api/golf/tee-times/bulk' }, last_tee: { type: 'string', example: '17:00' }, tee_interval_minutes: { type: 'integer', example: 10 }, default_max_players: { type: 'integer', default: 4, description: 'max_players stamped on auto-generated tee times' } } } } } }, responses: { 201: { description: 'Created (tee sheet seeds immediately if a complete schedule was supplied)' }, 400: { description: 'Invalid schedule (bad HH:MM, first_tee not before last_tee, non-positive interval/players)' } } },
    },
    '/api/golf/courses/{id}': {
      put: { tags: ['Golf'], summary: 'Update course', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, holes: { type: 'integer' }, price_per_player: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] }, first_tee: { type: 'string', example: '07:00', description: 'See POST /api/golf/courses -- schedule changes only shape slots not yet materialised; existing tee_time rows are never overwritten' }, last_tee: { type: 'string', example: '17:00' }, tee_interval_minutes: { type: 'integer', example: 10 }, default_max_players: { type: 'integer' } } } } } }, responses: { 200: { description: 'Updated (tee sheet extends immediately if the schedule is now complete and the course active)' }, 400: { description: 'Invalid schedule (checked against stored values too, so updating one end cannot invert the window)' }, 404: { description: 'Not found' } } },
    },
    '/api/golf/tee-times/bulk': {
      post: { tags: ['Golf'], summary: 'Bulk generate tee times', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['course_id', 'from', 'to', 'times', 'max_players'], properties: { course_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } }, max_players: { type: 'integer', default: 4 } } } } } }, responses: { 201: { description: 'Tee times created' }, 404: { description: 'Course not found' } } },
    },
    '/api/golf/tee-times/search': {
      get: { tags: ['Golf'], summary: 'Search available tee times', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'course_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'players', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available tee times with spots' } } },
    },
    '/api/golf/bookings': {
      get: { tags: ['Golf'], summary: 'List golf bookings', security: [{ bearerAuth: [] }], parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Golf'], summary: 'Book a tee time', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tee_time_id', 'contact_name', 'players'], properties: { tee_time_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, players: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 404: { description: 'Tee time or guest not found' }, 409: { description: 'Not enough spots' } } },
    },
    '/api/golf/bookings/live': {
      get: { tags: ['Golf'], summary: 'Property-wide live golf bookings feed', description: "Newest-first across every course, shaped for the live-bookings feed: contact_name split into first_name/last_name, plus tee_date/tee_time, course details, and proshop_items. Paginate by passing the oldest loaded booking's created_at as cursor.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Return bookings created before this timestamp' }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 30, maximum: 100 } }], responses: { 200: { description: 'Array of live-feed bookings' } } },
    },
    '/api/golf/bookings/{id}': {
      put: { tags: ['Golf'], summary: 'Update golf booking', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, notes: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },

    // ── Extras ────────────────────────────────────────────────────────────────
    '/api/extras': {
      get: { tags: ['Extras'], summary: 'List active extras', responses: { 200: { description: 'Array of extras' } } },
      post: { tags: ['Extras'], summary: 'Create extra (admin/staff)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created extra' }, 400: { description: 'Validation error' } } },
    },
    '/api/extras/{id}': {
      put: { tags: ['Extras'], summary: 'Update extra (admin/staff)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated extra' }, 404: { description: 'Not found' } } },
    },
    '/api/extras/booking/{booking_id}': {
      get: { tags: ['Extras'], summary: 'List extras on a booking', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of booking extras with name and totals' } } },
      post: { tags: ['Extras'], summary: 'Add extra to booking', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['extra_id'], properties: { extra_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', default: 1 } } } } } }, responses: { 201: { description: 'Extra added with locked unit_price and total' }, 404: { description: 'Extra or booking not found' } } },
    },
    '/api/extras/booking/{booking_id}/{id}': {
      delete: { tags: ['Extras'], summary: 'Remove extra from booking (admin/staff)', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Removed' }, 404: { description: 'Not found' } } },
    },

    // ── Restaurant Orders ─────────────────────────────────────────────────────
    '/api/restaurant-orders/menu': {
      get: { tags: ['Restaurant Orders'], summary: 'List menu items', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'restaurant_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of menu items' } } },
      post: { tags: ['Restaurant Orders'], summary: 'Create menu item', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, restaurant_id: { type: 'string', format: 'uuid', description: 'Optional — which restaurant this item belongs to' }, allergens: { type: 'array', items: { type: 'string' } }, variants: { type: 'array', items: { type: 'string' } }, translations: { type: 'object', additionalProperties: true, description: 'Keyed by language code, e.g. { "fr": { "name": "...", "description": "..." } }', example: { fr: { name: 'Steak frites', description: 'Servi avec une sauce au poivre' } } } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant-orders/menu/bulk-delete': {
      put: { tags: ['Restaurant Orders'], summary: 'Bulk delete menu items (soft delete)', description: 'Sets status to inactive on every matching item.', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } } }, responses: { 200: { description: '{ deleted, ids }' }, 400: { description: 'ids must be a non-empty array' } } },
    },
    '/api/restaurant-orders/menu/rename-category': {
      put: { tags: ['Restaurant Orders'], summary: 'Rename a menu category across its items', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' }, restaurant_id: { type: 'string', format: 'uuid', description: 'Limit the rename to one restaurant' } } } } } }, responses: { 200: { description: '{ renamed, ids }' }, 400: { description: 'from and to are required' } } },
    },
    '/api/restaurant-orders/menu/{id}': {
      put: { tags: ['Restaurant Orders'], summary: 'Update menu item', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] }, restaurant_id: { type: 'string', format: 'uuid' }, allergens: { type: 'array', items: { type: 'string' } }, variants: { type: 'array', items: { type: 'string' } }, translations: { type: 'object', additionalProperties: true, description: 'Keyed by language code -- replaces the whole object, not a per-language merge', example: { fr: { name: 'Steak frites', description: 'Servi avec une sauce au poivre' } } } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/restaurant-orders': {
      get: { tags: ['Restaurant Orders'], summary: 'List orders', parameters: [{ name: 'restaurant_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'booking_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'table_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'status', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of orders with line items' } } },
      post: { tags: ['Restaurant Orders'], summary: 'Place an order', description: 'Requires restaurant_id, plus either booking_id (delivered to a hotel room) or table_id (served at a restaurant table).', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['restaurant_id', 'items'], properties: { restaurant_id: { type: 'string', format: 'uuid' }, booking_id: { type: 'string', format: 'uuid', description: 'Required if table_id is not given' }, table_id: { type: 'string', format: 'uuid', description: 'Required if booking_id is not given' }, guest_id: { type: 'string', format: 'uuid' }, notes: { type: 'string' }, scheduled_for: { type: 'string', format: 'date-time', description: 'Optional scheduled delivery time' }, items: { type: 'array', items: { type: 'object', required: ['item_id'], properties: { item_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', default: 1 } } } } } } } } }, responses: { 201: { description: 'Order created with locked prices' }, 404: { description: 'Restaurant, booking, table, or item not found' } } },
    },
    '/api/restaurant-orders/{id}': {
      get: { tags: ['Restaurant Orders'], summary: 'Get order by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Order with line items' }, 404: { description: 'Not found' } } },
    },
    '/api/restaurant-orders/{id}/status': {
      put: { tags: ['Restaurant Orders'], summary: 'Update order status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'] } } } } } }, responses: { 200: { description: 'Updated order' }, 404: { description: 'Not found' } } },
    },
    '/api/restaurant-orders/ably-token': {
      get: { tags: ['Restaurant Orders'], summary: 'Mint a realtime subscribe token for one restaurant\'s order events', description: "Subscribe-only token for the restaurant:{restaurant_id}:orders channel. Events: new-order (includes table_session_id), order-status-changed, table-session-opened (fires only when a session is genuinely created -- by a first order or by seating a reservation; adding a round to an open tab does not fire it), and table-session-closed (carries payment_status/paid_at, so payment UIs learn the tab settled without polling). Session event payloads are the session row plus table_number. Staff surface only (org-scoped Clerk session required, and the channel carries every table's activity) -- guest-facing pages should use GET /api/restaurant-table-sessions/{id}/ably-token instead.", parameters: [{ name: 'restaurant_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Ably token request + channel name' }, 400: { description: 'restaurant_id missing' }, 404: { description: 'Restaurant not found' } } },
    },
    // ── Restaurant Table Sessions ────────────────────────────────────────────
    '/api/restaurant-table-sessions': {
      get: { tags: ['Restaurant Table Sessions'], summary: "Get a table's session (with its orders)", description: 'Used to decide "Add to order" vs "New order" before placing an order for a table.', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'table_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'closed'] } }], responses: { 200: { description: 'Session plus its orders (with line items)' }, 400: { description: 'table_id missing' }, 404: { description: 'Not found' } } },
      post: { tags: ['Restaurant Table Sessions'], summary: 'Open a table session explicitly (walk-in, before any order)', description: "Seats a walk-in without waiting for the first order (which otherwise opens the session implicitly). Idempotent: an already-open session for the table is returned (200) instead of erroring, whether from a repeat tap or an order having opened it. A genuine open (201) fires the table-session-opened realtime event. If the table has a confirmed reservation today not already linked to this session, reservation_warning carries a human-readable note -- the open is NOT blocked; the waiter judges. (Contrast POST /api/restaurant-orders, which hard-409s on an imminent reservation unless force: true.)", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_id'], properties: { table_id: { type: 'string', format: 'uuid' } } } } } }, responses: { 201: { description: 'Session opened -- session row + table_number + reservation_warning (string or null)' }, 200: { description: 'Existing open session returned (same shape)' }, 400: { description: 'table_id missing' }, 404: { description: 'Table not found' } } },
    },
    '/api/restaurant-table-sessions/connection-token': {
      post: { tags: ['Restaurant Table Sessions'], summary: 'Mint a Stripe Terminal connection token (Tap to Pay)', description: "Creates the property's Terminal Location lazily on first call (Tap to Pay has no physical reader, but the Terminal API still requires one) and stores it on the property.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: '{ secret, location_id }' }, 409: { description: 'No Stripe secret key configured for this property' }, 502: { description: 'Stripe error' } } },
    },
    '/api/restaurant-table-sessions/{id}': {
      get: { tags: ['Restaurant Table Sessions'], summary: 'Get a session by id (with its orders and reservation)', description: "Same shape as the table_id lookup, but addresses a specific session -- e.g. the one an order's table_session_id points at, which may no longer be the table's latest.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Session plus table_number, its orders (with line items), and reservation (null for walk-ins)' }, 404: { description: 'Not found' } } },
    },
    '/api/restaurant-table-sessions/{id}/ably-token': {
      get: { tags: ['Restaurant Table Sessions'], summary: "Mint a realtime subscribe token for one session's events (guest-safe)", description: "Subscribe-only token for the table-session:{id} channel, which receives this session's table-session-closed event (with payment_status/paid_at). This is the channel for guest-facing pages (e.g. table-pay): unlike the restaurant-wide orders channel -- staff-only to mint, and carrying every table's orders and payment states -- this exposes exactly one tab's settlement. A guest site's backend proxies the mint with its property API key.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Ably token request + channel name' }, 404: { description: 'Session not found' }, 503: { description: 'Realtime notifications are not configured' } } },
    },
    '/api/restaurant-table-sessions/{id}/payment-intent': {
      post: { tags: ['Restaurant Table Sessions'], summary: "Create (or reuse) the Stripe PaymentIntent for a session's total", description: "Settles the whole tab. channel picks the rail: 'terminal' (default, card_present for the waiter's reader) or 'online' (guest's own phone via Stripe Elements). Idempotent on retry: reuses the session's in-flight intent on the same rail, hands the tab to the other rail only if nothing is attached yet, and if the intent already succeeded (crash between tap and close) settles the session instead of double-charging -- returning { already_paid: true }.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { channel: { type: 'string', enum: ['terminal', 'online'], default: 'terminal' } } } } } }, responses: { 200: { description: '{ client_secret, payment_intent_id, amount, channel } -- or { already_paid: true, payment_intent_id }' }, 404: { description: 'Session not found' }, 409: { description: 'No Stripe key configured / session not open / already paid / other rail mid-payment / succeeded intent conflicts (wrong amount or active orders) / nothing to pay' }, 502: { description: 'Stripe error' } } },
    },
    '/api/restaurant-table-sessions/{id}/close': {
      put: { tags: ['Restaurant Table Sessions'], summary: 'Close a table session', description: "Payment-agnostic -- marks the tab done. Rejects if any order under the session is still pending/confirmed/preparing.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Closed session' }, 404: { description: 'Not found' }, 409: { description: 'Active orders still open under this session' } } },
    },
    // ── Pro Shop ──────────────────────────────────────────────────────────────
    '/api/proshop/shops': {
      get: { tags: ['Pro Shop'], summary: 'List shops', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: 'Array of shops' } } },
      post: { tags: ['Pro Shop'], summary: 'Create shop', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/proshop/shops/{id}': {
      put: { tags: ['Pro Shop'], summary: 'Update shop', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/proshop/items': {
      get: { tags: ['Pro Shop'], summary: 'List catalogue items', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'shop_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of items' } } },
      post: { tags: ['Pro Shop'], summary: 'Create catalogue item', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price', 'shop_id'], properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, shop_id: { type: 'string', format: 'uuid' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/proshop/items/{id}': {
      put: { tags: ['Pro Shop'], summary: 'Update catalogue item', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/proshop/booking/{booking_id}': {
      get: { tags: ['Pro Shop'], summary: 'List items on a golf booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of items with totals' } } },
      post: { tags: ['Pro Shop'], summary: 'Add item to golf booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['item_id'], properties: { item_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', default: 1 } } } } } }, responses: { 201: { description: 'Item added with locked unit_price' }, 404: { description: 'Item or booking not found' } } },
    },
    '/api/proshop/booking/{booking_id}/{id}': {
      delete: { tags: ['Pro Shop'], summary: 'Remove item from golf booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Removed' }, 404: { description: 'Not found' } } },
    },
  },
};

module.exports = swaggerSpec;
