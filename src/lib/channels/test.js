// The built-in test channel: a well-behaved channel with no network. Every
// push is acknowledged (so channel_ari shows what "the channel" holds), unless
// config.fail_pushes is on, which fails them all to exercise retries and drift.
module.exports = {
  label: 'Test channel',

  validateConfig(config) {
    const errors = [];
    for (const [k, v] of Object.entries(config || {})) {
      if (k !== 'fail_pushes') errors.push(`unknown setting ${k}`);
      else if (typeof v !== 'boolean') errors.push('fail_pushes must be true or false');
    }
    return errors;
  },

  async push(channel, changes) {
    const fail = channel.config?.fail_pushes === true;
    return changes.map(() => (fail ? { ok: false, error: 'test adapter: fail_pushes' } : { ok: true }));
  },
};
