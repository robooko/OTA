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
    name: 'create_guest',
    description: 'Create a new guest',
    inputSchema: {
      first_name: z.string(),
      last_name: z.string(),
      email: z.string(),
      phone: z.string().optional(),
    },
    run: (args) => apiRequest('POST', '/api/guests', { body: args }),
  },
  {
    name: 'lookup_guest',
    description: 'Look up a guest by email',
    inputSchema: { email: z.string() },
    run: (args) => apiRequest('GET', '/api/guests/lookup', { query: args }),
  },
  {
    name: 'create_booking',
    description: 'Create a booking for a guest, either a specific room or the first available room of a room type',
    inputSchema: {
      guest_id: z.string(),
      room_id: z.string().optional(),
      room_type_id: z.string().optional(),
      check_in: z.string(),
      check_out: z.string(),
      guests: z.number().int().optional(),
      metadata: z.record(z.any()).optional(),
    },
    run: (args) => apiRequest('POST', '/api/bookings', { body: args }),
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
    description: 'Update a room type',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      max_occupancy: z.number().int().optional(),
      base_rate: z.number().optional(),
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
    name: 'create_restaurant_reservation',
    description: 'Create a restaurant reservation (table auto-assigned)',
    inputSchema: {
      restaurant_id: z.string(),
      reservation_date: z.string(),
      start_time: z.string(),
      location: z.string().optional(),
      guest_id: z.string().optional(),
      clerk_user_id: z.string().optional(),
      contact_name: z.string(),
      contact_email: z.string().optional(),
      contact_phone: z.string().optional(),
      party_size: z.number().int(),
      notes: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    },
    run: ({ restaurant_id, ...body }) => apiRequest('POST', `/api/restaurant/${restaurant_id}/reservations`, { body }),
  },
  ];
}

module.exports = { createTools };
