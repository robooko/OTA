// Nights of a stay. Room holding lives in roomNights.js.

// Nights of a stay, [check_in, check_out).
function stayNights(checkIn, checkOut) {
  const nights = [];
  const d = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  while (d < end) {
    nights.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return nights;
}

module.exports = { stayNights };
