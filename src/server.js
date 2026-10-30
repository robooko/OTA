require('dotenv').config();
const app = require('./app');
const { startAvailabilityHorizonJob } = require('./lib/availabilitySeeder');
const { startTeeSheetHorizonJob } = require('./lib/teeTimeSeeder');
const { startTourTimetableHorizonJob } = require('./lib/tourSlotSeeder');
const { startReviewRequestJob } = require('./lib/reviewRequester');
const { startBasketReminderJob } = require('./lib/basketReminders');
const { startAgenticFeedJob } = require('./lib/agenticFeed');
const { startAgenticOrderJob } = require('./lib/agenticOrders');
const { startReminderJob } = require('./lib/reminders');
const { startHoldExpiryJob } = require('./lib/spaBookingGuard');
const { startMarinaHoldExpiryJob } = require('./lib/marinaLifecycle');
const { startRoomPaymentJobs } = require('./lib/roomPayments');

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  startAvailabilityHorizonJob();
  startTeeSheetHorizonJob();
  startTourTimetableHorizonJob();
  startReviewRequestJob();
  startBasketReminderJob();
  startAgenticFeedJob();
  startAgenticOrderJob();
  startReminderJob();
  startHoldExpiryJob();
  startMarinaHoldExpiryJob();
  startRoomPaymentJobs();
});
