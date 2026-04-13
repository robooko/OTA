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
  security: [{ apiKey: [] }],
  tags: [
    { name: 'Auth' },
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
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
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
      RoomServiceItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string' },
          price: { type: 'number' },
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
      },
      RoomServiceOrderItem: {
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
      RoomServiceOrder: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          booking_id: { type: 'string', format: 'uuid' },
          guest_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'] },
          notes: { type: 'string' },
          total_price: { type: 'number' },
          scheduled_for: { type: 'string', format: 'date-time', description: 'Optional delivery time e.g. 07:30 next morning' },
          created_at: { type: 'string', format: 'date-time' },
          items: { type: 'array', items: { $ref: '#/components/schemas/RoomServiceOrderItem' } },
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
    '/api/auth/register': {
      post: { tags: ['Auth'], summary: 'Register a new user', security: [], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' }, role: { type: 'string', enum: ['admin', 'staff', 'guest'], default: 'staff' } } } } } }, responses: { 201: { description: 'User created with JWT token' } } },
    },
    '/api/auth/login': {
      post: { tags: ['Auth'], summary: 'Login and receive JWT token', security: [], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' } } } } } }, responses: { 200: { description: 'JWT token' }, 401: { description: 'Invalid credentials' } } },
    },
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Get current user', responses: { 200: { description: 'Current user profile' } } },
    },
    '/api/auth/users': {
      get: { tags: ['Auth'], summary: 'List all users (admin only)', responses: { 200: { description: 'Array of users' }, 403: { description: 'Forbidden' } } },
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
    },
    '/api/guests/lookup': {
      get: { tags: ['Guests'], summary: 'Look up guest by email', security: [{ apiKey: [] }], parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } }], responses: { 200: { description: 'Guest found' }, 404: { description: 'Guest not found' } } },
    },
    '/api/guests/{id}': {
      get: { tags: ['Guests'], summary: 'Get guest by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Guest' }, 404: { description: 'Not found' } } },
      put: { tags: ['Guests'], summary: 'Update guest', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated guest' } } },
      delete: { tags: ['Guests'], summary: 'Delete guest', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Deleted' } } },
    },

    // ── Room Types ───────────────────────────────────────────────────────────
    '/api/room-types': {
      get: { tags: ['Room Types'], summary: 'List all room types', responses: { 200: { description: 'Array of room types' } } },
      post: { tags: ['Room Types'], summary: 'Create room type', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'max_occupancy', 'base_rate'], properties: { name: { type: 'string' }, description: { type: 'string' }, max_occupancy: { type: 'integer' }, base_rate: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/room-types/{id}': {
      get: { tags: ['Room Types'], summary: 'Get room type by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Room type' } } },
      put: { tags: ['Room Types'], summary: 'Update room type', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, max_occupancy: { type: 'integer' }, base_rate: { type: 'number' } } } } } }, responses: { 200: { description: 'Updated' } } },
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
      get: { tags: ['Availability'], summary: 'Search available room types', parameters: [{ name: 'check_in', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'check_out', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'guests', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Available room types with rates' } } },
    },
    '/api/availability/rooms/{room_id}': {
      get: { tags: ['Availability'], summary: 'Get availability for a room', parameters: [{ name: 'room_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'Availability records' } } },
      put: { tags: ['Availability'], summary: 'Bulk upsert availability for a room', parameters: [{ name: 'room_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['dates'], properties: { dates: { type: 'array', items: { type: 'object', properties: { date: { type: 'string', format: 'date' }, is_available: { type: 'boolean' }, override_rate: { type: 'number' }, block_reason: { type: 'string' } } } } } } } } }, responses: { 200: { description: 'Updated records' } } },
    },
    '/api/availability/overrides': {
      get: { tags: ['Availability'], summary: 'List all override rates', parameters: [{ name: 'room_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'Override records with room and rate info' } } },
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
      post: { tags: ['Bookings'], summary: 'Create booking', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'room_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room not available' } } },
    },
    '/api/bookings/{id}': {
      get: { tags: ['Bookings'], summary: 'Get booking by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Booking with guest and room details' } } },
      put: { tags: ['Bookings'], summary: 'Update booking', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['confirmed', 'cancelled', 'checked_in', 'checked_out'] }, guests: { type: 'integer' } } } } } }, responses: { 200: { description: 'Updated' } } },
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
      get: { tags: ['Restaurant'], summary: 'List all restaurants', responses: { 200: { description: 'Array of restaurants' } } },
      post: { tags: ['Restaurant'], summary: 'Create restaurant', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{id}': {
      get: { tags: ['Restaurant'], summary: 'Get restaurant by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Restaurant' } } },
      put: { tags: ['Restaurant'], summary: 'Update restaurant', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, phone: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
    },
    '/api/restaurant/{restaurant_id}/tables': {
      get: { tags: ['Restaurant'], summary: 'List tables', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of tables' } } },
      post: { tags: ['Restaurant'], summary: 'Create table', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_number', 'seats'], properties: { table_number: { type: 'string' }, seats: { type: 'integer' }, location: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/restaurant/{restaurant_id}/slots/bulk': {
      post: { tags: ['Restaurant'], summary: 'Bulk generate time slots', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['from', 'to', 'times', 'available_seats'], properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' }, example: ['12:00', '14:00', '18:00', '19:30', '21:00'] }, available_seats: { type: 'integer' } } } } } }, responses: { 201: { description: 'Slots created' } } },
    },
    '/api/restaurant/{restaurant_id}/slots/search': {
      get: { tags: ['Restaurant'], summary: 'Search available slots', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'party_size', in: 'query', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Available slots with table counts' } } },
    },
    '/api/restaurant/{restaurant_id}/reservations': {
      get: { tags: ['Restaurant'], summary: 'List reservations', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of reservations' } } },
      post: { tags: ['Restaurant'], summary: 'Create reservation', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['table_id', 'time_slot_id', 'contact_name', 'party_size'], properties: { table_id: { type: 'string', format: 'uuid' }, time_slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'Table already booked' } } },
    },

    // ── Spa ──────────────────────────────────────────────────────────────────
    '/api/spa/treatments': {
      get: { tags: ['Spa'], summary: 'List treatments', responses: { 200: { description: 'Array of treatments' } } },
      post: { tags: ['Spa'], summary: 'Create treatment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/therapists': {
      get: { tags: ['Spa'], summary: 'List therapists', responses: { 200: { description: 'Array of therapists' } } },
      post: { tags: ['Spa'], summary: 'Create therapist', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/spa/slots/bulk': {
      post: { tags: ['Spa'], summary: 'Bulk generate spa slots', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['therapist_id', 'treatment_id', 'from', 'to', 'times'], properties: { therapist_id: { type: 'string', format: 'uuid' }, treatment_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' }, example: ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00'] } } } } } }, responses: { 201: { description: 'Slots created' } } },
    },
    '/api/spa/slots/search': {
      get: { tags: ['Spa'], summary: 'Search available spa slots', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'treatment_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Available slots with therapist and treatment info' } } },
    },
    '/api/spa/appointments': {
      get: { tags: ['Spa'], summary: 'List appointments', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of appointments' } } },
      post: { tags: ['Spa'], summary: 'Book spa appointment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Appointment booked' }, 409: { description: 'Slot already booked' } } },
    },

    // ── Beach Club ───────────────────────────────────────────────────────────
    '/api/beach-club/beds': {
      get: { tags: ['Beach Club'], summary: 'List beds', parameters: [{ name: 'zone', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of beds' } } },
      post: { tags: ['Beach Club'], summary: 'Create bed', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['bed_number'], properties: { bed_number: { type: 'string' }, zone: { type: 'string', example: 'pool, beach, VIP' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/beach-club/beds/search': {
      get: { tags: ['Beach Club'], summary: 'Search available beds', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'zone', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Available beds' } } },
    },
    '/api/beach-club/bookings': {
      get: { tags: ['Beach Club'], summary: 'List beach club bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'zone', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Beach Club'], summary: 'Book a beach bed', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['bed_id', 'contact_name', 'date'], properties: { bed_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, date: { type: 'string', format: 'date' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created' }, 409: { description: 'Bed already booked' } } },
    },

    // ── Tours ────────────────────────────────────────────────────────────────
    '/api/tours': {
      get: { tags: ['Tours'], summary: 'List tours', responses: { 200: { description: 'Array of tours' } } },
      post: { tags: ['Tours'], summary: 'Create tour', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'duration_mins', 'max_group_size', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, duration_mins: { type: 'integer' }, max_group_size: { type: 'integer' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/tours/slots/bulk': {
      post: { tags: ['Tours'], summary: 'Bulk generate tour slots', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tour_id', 'from', 'to', 'times'], properties: { tour_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } } } } } } }, responses: { 201: { description: 'Slots created' } } },
    },
    '/api/tours/slots/search': {
      get: { tags: ['Tours'], summary: 'Search available tour slots', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'tour_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'group_size', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available slots with capacity info' } } },
    },
    '/api/tours/bookings': {
      get: { tags: ['Tours'], summary: 'List tour bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Tours'], summary: 'Book a tour', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['slot_id', 'contact_name', 'group_size'], properties: { slot_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, group_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Not enough spots' } } },
    },

    // ── Equipment ────────────────────────────────────────────────────────────
    '/api/equipment': {
      get: { tags: ['Equipment'], summary: 'List equipment', parameters: [{ name: 'type', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of equipment' } } },
      post: { tags: ['Equipment'], summary: 'Create equipment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'type', 'quantity'], properties: { name: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'integer' }, price_per_day: { type: 'number' }, price_per_hour: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/equipment/search': {
      get: { tags: ['Equipment'], summary: 'Search available equipment', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'type', in: 'query', schema: { type: 'string' } }, { name: 'quantity', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available equipment with quantities' } } },
    },
    '/api/equipment/hires': {
      get: { tags: ['Equipment'], summary: 'List hire bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'golf_booking_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of hires' } } },
      post: { tags: ['Equipment'], summary: 'Hire equipment', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['equipment_id', 'contact_name', 'hire_date', 'quantity'], properties: { equipment_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, hire_date: { type: 'string', format: 'date' }, quantity: { type: 'integer' }, notes: { type: 'string' }, rate_type: { type: 'string', enum: ['per_day', 'per_hour'], default: 'per_day' }, duration: { type: 'number', default: 1, description: 'Days or hours depending on rate_type' }, golf_booking_id: { type: 'string', format: 'uuid', description: 'Link to a golf booking' }, total_price: { type: 'number', readOnly: true, description: 'rate × quantity × duration' } } } } } }, responses: { 201: { description: 'Hire created with total_price' }, 409: { description: 'Not enough available' } } },
    },

    // ── Golf ─────────────────────────────────────────────────────────────────
    '/api/golf/courses': {
      get: { tags: ['Golf'], summary: 'List courses', responses: { 200: { description: 'Array of courses' } } },
      post: { tags: ['Golf'], summary: 'Create course', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'holes', 'price_per_player'], properties: { name: { type: 'string' }, description: { type: 'string' }, holes: { type: 'integer' }, price_per_player: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/golf/tee-times/bulk': {
      post: { tags: ['Golf'], summary: 'Bulk generate tee times', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['course_id', 'from', 'to', 'times', 'max_players'], properties: { course_id: { type: 'string', format: 'uuid' }, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, times: { type: 'array', items: { type: 'string' } }, max_players: { type: 'integer', default: 4 } } } } } }, responses: { 201: { description: 'Tee times created' } } },
    },
    '/api/golf/tee-times/search': {
      get: { tags: ['Golf'], summary: 'Search available tee times', parameters: [{ name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'course_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'players', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Available tee times with spots' } } },
    },
    '/api/golf/bookings': {
      get: { tags: ['Golf'], summary: 'List golf bookings', parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of bookings' } } },
      post: { tags: ['Golf'], summary: 'Book a tee time', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tee_time_id', 'contact_name', 'players'], properties: { tee_time_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, players: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Not enough spots' } } },
    },

    // ── Extras ────────────────────────────────────────────────────────────────
    '/api/extras': {
      get: { tags: ['Extras'], summary: 'List active extras (API key)', security: [{ apiKey: [] }], responses: { 200: { description: 'Array of extras' } } },
      post: { tags: ['Extras'], summary: 'Create extra (admin/staff)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created extra' }, 400: { description: 'Validation error' } } },
    },
    '/api/extras/{id}': {
      put: { tags: ['Extras'], summary: 'Update extra (admin/staff)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated extra' }, 404: { description: 'Not found' } } },
    },
    '/api/extras/booking/{booking_id}': {
      get: { tags: ['Extras'], summary: 'List extras on a booking (API key)', security: [{ apiKey: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of booking extras with name and totals' } } },
      post: { tags: ['Extras'], summary: 'Add extra to booking (API key)', security: [{ apiKey: [] }], parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['extra_id'], properties: { extra_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', default: 1 } } } } } }, responses: { 201: { description: 'Extra added with locked unit_price and total' }, 404: { description: 'Extra or booking not found' } } },
    },
    '/api/extras/booking/{booking_id}/{id}': {
      delete: { tags: ['Extras'], summary: 'Remove extra from booking (admin/staff)', parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 204: { description: 'Removed' }, 404: { description: 'Not found' } } },
    },

    // ── Room Service ──────────────────────────────────────────────────────────
    '/api/room-service/menu': {
      get: { tags: ['Room Service'], summary: 'List menu items', security: [], parameters: [{ name: 'category', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of menu items' } } },
      post: { tags: ['Room Service'], summary: 'Create menu item', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'price'], properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' } } } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/api/room-service/menu/{id}': {
      put: { tags: ['Room Service'], summary: 'Update menu item', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, price: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] } } } } } }, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
    },
    '/api/room-service/orders': {
      get: { tags: ['Room Service'], summary: 'List orders', parameters: [{ name: 'booking_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'status', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of orders with line items' } } },
      post: { tags: ['Room Service'], summary: 'Place an order', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['booking_id', 'items'], properties: { booking_id: { type: 'string', format: 'uuid' }, guest_id: { type: 'string', format: 'uuid' }, notes: { type: 'string' }, scheduled_for: { type: 'string', format: 'date-time', description: 'Optional scheduled delivery time' }, items: { type: 'array', items: { type: 'object', required: ['item_id'], properties: { item_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', default: 1 } } } } } } } } }, responses: { 201: { description: 'Order created with locked prices' }, 404: { description: 'Booking or item not found' } } },
    },
    '/api/room-service/orders/{id}': {
      get: { tags: ['Room Service'], summary: 'Get order by ID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Order with line items' }, 404: { description: 'Not found' } } },
    },
    '/api/room-service/orders/{id}/status': {
      put: { tags: ['Room Service'], summary: 'Update order status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled'] } } } } } }, responses: { 200: { description: 'Updated order' }, 404: { description: 'Not found' } } },
    },
  },
};

module.exports = swaggerSpec;
