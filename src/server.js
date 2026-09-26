require('dotenv').config();
const app = require('./app');
const { startAvailabilityHorizonJob } = require('./lib/availabilitySeeder');
const { startTeeSheetHorizonJob } = require('./lib/teeTimeSeeder');
const { startTourTimetableHorizonJob } = require('./lib/tourSlotSeeder');
const { startReviewRequestJob } = require('./lib/reviewRequester');
const { startReminderJob } = require('./lib/reminders');
const { startHoldExpiryJob } = require('./lib/spaBookingGuard');

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  startAvailabilityHorizonJob();
  startTeeSheetHorizonJob();
  startTourTimetableHorizonJob();
  startReviewRequestJob();
  startReminderJob();
  startHoldExpiryJob();
});
