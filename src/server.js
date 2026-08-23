require('dotenv').config();
const app = require('./app');
const { startAvailabilityHorizonJob } = require('./lib/availabilitySeeder');

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  startAvailabilityHorizonJob();
});
