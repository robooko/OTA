require('dotenv').config();
const app = require('./app');
const { startAvailabilityHorizonJob } = require('./lib/availabilitySeeder');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startAvailabilityHorizonJob();
});
