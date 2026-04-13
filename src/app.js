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
const roomServiceRoutes = require('./routes/roomService');
const proshopRoutes = require('./routes/proshop');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
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
app.use('/api/room-service', roomServiceRoutes);
app.use('/api/proshop', proshopRoutes);

app.use(errorHandler);

module.exports = app;
