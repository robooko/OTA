const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./docs/swagger');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const guestRoutes = require('./routes/guests');
const roomTypeRoutes = require('./routes/roomTypes');
const roomRoutes = require('./routes/rooms');
const availabilityRoutes = require('./routes/availability');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const restaurantRoutes = require('./routes/restaurant');
const spaRoutes = require('./routes/spa');
const beachClubRoutes = require('./routes/beachClub');
const toursRoutes = require('./routes/tours');
const equipmentRoutes = require('./routes/equipment');
const golfRoutes = require('./routes/golf');
const extrasRoutes = require('./routes/extras');
const restaurantOrderRoutes = require('./routes/restaurantOrders');
const restaurantTableSessionRoutes = require('./routes/restaurantTableSessions');
const proshopRoutes = require('./routes/proshop');
const propertyRoutes = require('./routes/property');
const eventInquiryRoutes = require('./routes/eventInquiries');
const mcpRoutes = require('./routes/mcp');
const billingRoutes = require('./routes/billing');

const app = express();

const { handleResendInboundWebhook } = require('./controllers/eventInquiries');
const { handleStripeWebhook } = require('./controllers/billing');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// Must come before express.json() -- Svix verification needs the raw
// body, and this scopes that requirement to exactly this one path.
app.post(
  '/api/event-inquiries/webhooks/resend-inbound',
  express.raw({ type: 'application/json' }),
  handleResendInboundWebhook
);
// Same reason: Stripe signature verification needs the raw body.
app.post(
  '/api/billing/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

app.use(express.json());

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));
app.use('/api/auth', authRoutes);

app.use('/api/guests', guestRoutes);
app.use('/api/room-types', roomTypeRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/spa', spaRoutes);
app.use('/api/beach-club', beachClubRoutes);
app.use('/api/tours', toursRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/golf', golfRoutes);
app.use('/api/extras', extrasRoutes);
app.use('/api/restaurant-orders', restaurantOrderRoutes);
app.use('/api/restaurant-table-sessions', restaurantTableSessionRoutes);
app.use('/api/proshop', proshopRoutes);
app.use('/api/property', propertyRoutes);
app.use('/api/event-inquiries', eventInquiryRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/billing', billingRoutes);

app.use(errorHandler);

module.exports = app;
