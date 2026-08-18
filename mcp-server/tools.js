const { z } = require('zod');

function createTools(apiRequest) {
  return [
  {
    name: 'search_availability',
    description: 'Search available room types for a date range and party size',
    inputSchema: {
      check_in: z.string().describe('YYYY-MM-DD'),
      check_out: z.string().describe('YYYY-MM-DD'),
      guests: z.number().int(),
    },
    run: (args) => apiRequest('GET', '/api/availability/search', { query: args }),
  },
  {
    name: 'lookup_guest',
    description: 'Look up a guest by email',
    inputSchema: { email: z.string() },
    run: (args) => apiRequest('GET', '/api/guests/lookup', { query: args }),
  },
  {
    name: 'list_bookings',
    description: 'List bookings, optionally filtered by status, guest, or date range',
    inputSchema: {
      status: z.string().optional(),
      guest_id: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    run: (args) => apiRequest('GET', '/api/bookings', { query: args }),
  },
  {
    name: 'get_booking',
    description: 'Get a booking by id',
    inputSchema: { id: z.string() },
    run: ({ id }) => apiRequest('GET', `/api/bookings/${id}`),
  },
  {
    name: 'cancel_booking',
    description: 'Cancel a booking and restore its room availability',
    inputSchema: { id: z.string() },
    run: ({ id }) => apiRequest('DELETE', `/api/bookings/${id}`),
  },
  {
    name: 'list_rooms',
    description: 'List rooms, optionally filtered by room type',
    inputSchema: { room_type_id: z.string().optional() },
    run: (args) => apiRequest('GET', '/api/rooms', { query: args }),
  },
  {
    name: 'create_room',
    description: 'Create a room',
    inputSchema: {
      room_type_id: z.string(),
      room_number: z.string(),
      floor: z.number().int().optional(),
    },
    run: (args) => apiRequest('POST', '/api/rooms', { body: args }),
  },
  {
    name: 'update_room',
    description: 'Update a room',
    inputSchema: {
      id: z.string(),
      room_number: z.string().optional(),
      floor: z.number().int().optional(),
      status: z.enum(['active', 'maintenance', 'inactive']).optional(),
    },
    run: ({ id, ...body }) => apiRequest('PUT', `/api/rooms/${id}`, { body }),
  },
  {
    name: 'list_room_types',
    description: 'List all room types',
    inputSchema: {},
    run: () => apiRequest('GET', '/api/room-types'),
  },
  {
    name: 'create_room_type',
    description: 'Create a room type',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      max_occupancy: z.number().int(),
      base_rate: z.number(),
    },
    run: (args) => apiRequest('POST', '/api/room-types', { body: args }),
  },
  {
    name: 'update_room_type',
    description: 'Update a room type. Set status to "inactive" to delete it — there is no hard-delete endpoint.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      max_occupancy: z.number().int().optional(),
      base_rate: z.number().optional(),
      status: z.enum(['active', 'inactive']).optional(),
    },
    run: ({ id, ...body }) => apiRequest('PUT', `/api/room-types/${id}`, { body }),
  },
  {
    name: 'upsert_room_availability',
    description: "Bulk set a room's availability and rates for specific dates",
    inputSchema: {
      room_id: z.string(),
      dates: z.array(z.object({
        date: z.string(),
        is_available: z.boolean().optional(),
        override_rate: z.number().optional(),
        block_reason: z.string().optional(),
      })),
    },
    run: ({ room_id, dates }) => apiRequest('PUT', `/api/availability/rooms/${room_id}`, { body: { dates } }),
  },
  {
    name: 'list_restaurants',
    description: 'List all restaurants',
    inputSchema: {},
    run: () => apiRequest('GET', '/api/restaurant'),
  },
  {
    name: 'create_restaurant',
    description: 'Create a restaurant',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      phone: z.string().optional(),
      slot_interval_minutes: z.number().int().optional(),
      default_duration_minutes: z.number().int(),
      closed_days: z.array(z.number().int().min(1).max(7)).optional(),
      currency: z.string().optional().describe('ISO 4217 code, e.g. GBP. Omit to inherit the property\'s currency'),
      timezone: z.string().optional().describe('IANA timezone name, e.g. Europe/London. Omit to inherit the property\'s timezone'),
    },
    run: (args) => apiRequest('POST', '/api/restaurant', { body: args }),
  },
  {
    name: 'get_restaurant',
    description: 'Get a restaurant by id',
    inputSchema: { id: z.string() },
    run: ({ id }) => apiRequest('GET', `/api/restaurant/${id}`),
  },
  {
    name: 'list_restaurant_reservations',
    description: 'List reservations for a restaurant, optionally filtered by date, status, or guest',
    inputSchema: {
      restaurant_id: z.string(),
      date: z.string().optional(),
      status: z.string().optional(),
      guest_id: z.string().optional(),
      clerk_user_id: z.string().optional(),
    },
    run: ({ restaurant_id, ...query }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/reservations`, { query }),
  },
  {
    name: 'get_restaurant_reservation',
    description: 'Get a restaurant reservation by id',
    inputSchema: { restaurant_id: z.string(), id: z.string() },
    run: ({ restaurant_id, id }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/reservations/${id}`),
  },
  {
    name: 'update_restaurant_reservation',
    description: 'Update a restaurant reservation (e.g. set status to "cancelled" to cancel it)',
    inputSchema: {
      restaurant_id: z.string(),
      id: z.string(),
      status: z.string().optional(),
      notes: z.string().optional(),
      contact_name: z.string().optional(),
      contact_email: z.string().optional(),
      contact_phone: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    },
    run: ({ restaurant_id, id, ...body }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/reservations/${id}`, { body }),
  },
  {
    name: 'update_tour_slot',
    description: 'Update a tour slot\'s status (e.g. set to "inactive" to hide it from search without deleting it)',
    inputSchema: { id: z.string(), status: z.string() },
    run: ({ id, status }) => apiRequest('PUT', `/api/tours/slots/${id}`, { body: { status } }),
  },
  {
    name: 'list_restaurant_tables',
    description: 'List tables for a restaurant',
    inputSchema: { restaurant_id: z.string() },
    run: ({ restaurant_id }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/tables`),
  },
  {
    name: 'create_restaurant_table',
    description: 'Create a table for a restaurant',
    inputSchema: { restaurant_id: z.string(), table_number: z.string(), seats: z.number().int(), location: z.string().optional() },
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/tables`, { body }),
  },
  {
    name: 'update_restaurant_table',
    description: 'Update a restaurant table',
    inputSchema: { restaurant_id: z.string(), id: z.string(), table_number: z.string().optional(), seats: z.number().int().optional(), location: z.string().optional(), status: z.enum(['active', 'inactive']).optional() },
    run: ({ restaurant_id, id, ...body }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/tables/${id}`, { body }),
  },
  {
    name: 'list_restaurant_menu',
    description: 'List menu items for room/table service, optionally filtered by restaurant or category',
    inputSchema: {
      restaurant_id: z.string().optional(),
      category: z.string().optional(),
    },
    run: (query) => apiRequest('GET', '/api/restaurant-orders/menu', { query }),
  },
  {
    name: 'create_restaurant_menu_item',
    description: 'Create a menu item for room/table service',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      price: z.number(),
      restaurant_id: z.string().optional().describe('Omit for a property-wide item not tied to one restaurant'),
      allergens: z.array(z.string()).optional(),
      translations: z.record(z.object({ name: z.string().optional(), description: z.string().optional() }))
        .optional()
        .describe('Keyed by language code, e.g. { "fr": { "name": "...", "description": "..." } }'),
    },
    run: (args) => apiRequest('POST', '/api/restaurant-orders/menu', { body: args }),
  },
  {
    name: 'update_restaurant_menu_item',
    description: 'Update a menu item. Set status to "inactive" to delete it — there is no hard-delete endpoint.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      price: z.number().optional(),
      restaurant_id: z.string().optional(),
      allergens: z.array(z.string()).optional(),
      translations: z.record(z.object({ name: z.string().optional(), description: z.string().optional() }))
        .optional()
        .describe('Keyed by language code -- replaces the whole object, not a per-language merge'),
      status: z.enum(['active', 'inactive']).optional(),
    },
    run: ({ id, ...body }) => apiRequest('PUT', `/api/restaurant-orders/menu/${id}`, { body }),
  },
  {
    name: 'get_restaurant_service_periods',
    description: "List a restaurant's service periods (bookable windows)",
    inputSchema: { restaurant_id: z.string() },
    run: ({ restaurant_id }) => apiRequest('GET', `/api/restaurant/${restaurant_id}/service-periods`),
  },
  {
    name: 'set_restaurant_service_periods',
    description: "Replace all of a restaurant's service periods",
    inputSchema: {
      restaurant_id: z.string(),
      periods: z.array(z.object({
        label: z.string().optional(),
        start_time: z.string(),
        end_time: z.string(),
      })),
    },
    run: ({ restaurant_id, periods }) => apiRequest('PUT', `/api/restaurant/${restaurant_id}/service-periods`, { body: { periods } }),
  },
  {
    name: 'list_proshop_shops',
    description: 'List pro shops',
    inputSchema: {},
    run: () => apiRequest('GET', '/api/proshop/shops'),
  },
  {
    name: 'create_proshop_shop',
    description: 'Create a pro shop',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
    },
    run: (args) => apiRequest('POST', '/api/proshop/shops', { body: args }),
  },
  {
    name: 'update_proshop_shop',
    description: 'Update a pro shop. Set status to "inactive" to delete it — there is no hard-delete endpoint.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['active', 'inactive']).optional(),
    },
    run: ({ id, ...body }) => apiRequest('PUT', `/api/proshop/shops/${id}`, { body }),
  },
  {
    name: 'list_proshop_items',
    description: 'List pro shop catalogue items, optionally filtered by shop or category',
    inputSchema: {
      shop_id: z.string().optional(),
      category: z.string().optional(),
    },
    run: (args) => apiRequest('GET', '/api/proshop/items', { query: args }),
  },
  {
    name: 'create_proshop_item',
    description: 'Create a pro shop catalogue item',
    inputSchema: {
      shop_id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      price: z.number(),
    },
    run: (args) => apiRequest('POST', '/api/proshop/items', { body: args }),
  },
  {
    name: 'update_proshop_item',
    description: 'Update a pro shop catalogue item. Set status to "inactive" to delete it — there is no hard-delete endpoint.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      price: z.number().optional(),
      status: z.enum(['active', 'inactive']).optional(),
    },
    run: ({ id, ...body }) => apiRequest('PUT', `/api/proshop/items/${id}`, { body }),
  },
  {
    name: 'list_proshop_booking_items',
    description: 'List pro shop items added to a golf booking',
    inputSchema: { booking_id: z.string() },
    run: ({ booking_id }) => apiRequest('GET', `/api/proshop/booking/${booking_id}`),
  },
  {
    name: 'add_proshop_booking_item',
    description: 'Add a pro shop catalogue item to a golf booking',
    inputSchema: {
      booking_id: z.string(),
      item_id: z.string(),
      quantity: z.number().int().optional(),
    },
    run: ({ booking_id, ...body }) => apiRequest('POST', `/api/proshop/booking/${booking_id}`, { body }),
  },
  {
    name: 'remove_proshop_booking_item',
    description: 'Remove a pro shop item from a golf booking',
    inputSchema: { booking_id: z.string(), id: z.string() },
    run: ({ booking_id, id }) => apiRequest('DELETE', `/api/proshop/booking/${booking_id}/${id}`),
  },
  ];
}

module.exports = { createTools };
