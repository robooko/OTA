// Talk to the AI receptionist (controllers/voice.js) from the terminal: the
// real model and tools against the local DB, no phone or Twilio. Type as the
// caller; each reply prints with how long the turn took.
//   node -r dotenv/config scripts/talk-receptionist.js [--property <id>] [--sms] [--say] [--email]
//   node -r dotenv/config scripts/talk-receptionist.js < calls/book-a-call.txt   (replay, one caller line per line)
// --say reads replies aloud with Windows' voice, to hear the pacing.
// --email: as if texts can't be sent, so it asks for an email (the old flow).
// Local DB only: enquiries and bookings it makes are real rows there.
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const pool = require('../src/db');
// Texts print here instead of sending; the confirm link in them works locally too.
const twilio = require('../src/lib/twilio');
twilio.isConfigured = () => !process.argv.includes('--email');
twilio.sendSms = async (to, body, from) => { console.log(`    [SMS ${from} -> ${to}] ${body}`); return 'SM_local'; };
const { runReceptionist } = require('../src/controllers/voice');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const channel = process.argv.includes('--sms') ? 'sms' : 'phone';
const speak = process.argv.includes('--say');
const CALLER = '+447700900999';

const sayAloud = (text) => {
  if (!speak || !text) return;
  const ps = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:T)`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { env: { ...process.env, T: text }, stdio: 'ignore' });
};

(async () => {
  // Same columns as findProperty, picked by id instead of dialled number.
  const { rows: [property] } = await pool.query(
    `SELECT p.id, p.name, p.currency, p.ai_reply_instructions, p.return_instructions, p.voice_transfer_number, p.voice_number,
            (SELECT s.id FROM spa s WHERE s.property_id = p.id AND s.status = 'active' ORDER BY s.created_at LIMIT 1) AS spa_id
     FROM property p
     WHERE ($1::uuid IS NULL OR p.id = $1::uuid)
       AND EXISTS (SELECT 1 FROM spa s WHERE s.property_id = p.id AND s.status = 'active')
     ORDER BY p.created_at LIMIT 1`,
    [arg('--property')]
  );
  if (!property) throw new Error('no property with an active spa');
  property.voice_number ??= '+447700900123'; // so the receptionist can text

  const greeting = `Hello, you've reached ${property.name}. How can I help?`;
  const turns = channel === 'phone' ? [{ r: 'a', t: greeting }] : [];
  let inquiryId = null;
  console.log(`${property.name} (${property.id}), ${channel}${property.voice_transfer_number ? ', transfer on' : ''}\n`);
  if (channel === 'phone') { console.log(`AI: ${greeting}`); sayAloud(greeting); }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\nYou: ' });
  if (process.stdin.isTTY) rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (!process.stdin.isTTY) console.log(`\nYou: ${text}`); // echo replayed lines
    turns.push({ r: 'u', t: text });
    const t0 = Date.now();
    const result = await runReceptionist(property, { caller: CALLER, turns, inquiryId, channel });
    const ms = Date.now() - t0;
    inquiryId = result.inquiryId;
    turns.push({ r: 'a', t: [result.reply, ...result.done].join(' ') });
    console.log(`AI: ${result.reply || '(silence: caller hears "say that again")'}`);
    console.log(`    ${ms}ms${ms > 11000 ? ' TOO SLOW: Twilio would hand off' : ''}${result.done.length ? `  ${result.done.join(' ')}` : ''}${result.transfer ? '  [TRANSFER]' : ''}`);
    sayAloud(result.reply);
    if (result.transfer) break;
    if (process.stdin.isTTY) rl.prompt();
  }
  await pool.end();
})().catch((err) => { console.error(err); process.exit(1); });
