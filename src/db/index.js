const { Pool, types } = require('pg');

// DATE columns (OID 1082) are parsed by pg into a JS Date at local-midnight,
// then serialized back to JSON as a UTC ISO string - shifting the calendar
// day whenever the process isn't running in UTC. Keep the raw 'YYYY-MM-DD'
// string instead, since nothing here needs Date arithmetic on it.
types.setTypeParser(1082, (val) => val);

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

module.exports = pool;
