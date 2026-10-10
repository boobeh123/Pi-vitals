const fs = require('node:fs');
const path = require('node:path');

const THERMAL_PATH = '/sys/class/thermal/thermal_zone0/temp';
// data/ is gitignored. Only the minute averages are saved; the 2-second readings are rebuilt within
// 5 minutes. HISTORY_FILE can point somewhere else; the tests use it to stay away from the real file.
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, '..', 'data', 'history.json');

const SAMPLE_MS = 2000; // the same pace as the dashboard's polls
const MINUTE_MS = 60 * 1000;
const RECENT_MS = 5 * MINUTE_MS; // 2-second readings kept for the 5-minute chart
const DAY_MS = 24 * 60 * MINUTE_MS; // minute averages kept for the 1-hour and 24-hour charts
const SAVE_EVERY_MS = 10 * MINUTE_MS;

const recent = []; // { time, tempC } every 2 seconds, newest last
let minutes = []; // { time, tempC } one average per minute, stamped at the middle of its minute
let currentMinute = null; // running total for the minute being averaged

/**************************************************************
Helpers
***************************************************************/

const readTempC = () => {
  try {
    return Number(fs.readFileSync(THERMAL_PATH, 'utf8').trim()) / 1000;
  } catch {
    return null;
  }
};

const dropOlderThan = (samples, cutoff) => {
  while (samples.length > 0 && samples[0].time < cutoff) samples.shift();
};

// Store the finished minute's average, then forget anything older than a day
const finishMinute = () => {
  minutes.push({
    time: currentMinute.start + MINUTE_MS / 2,
    tempC: Math.round((currentMinute.total / currentMinute.count) * 100) / 100,
  });
  currentMinute = null;
  dropOlderThan(minutes, Date.now() - DAY_MS);
};

const takeSample = () => {
  const tempC = readTempC();
  if (tempC === null) return;
  const time = Date.now();

  recent.push({ time, tempC });
  dropOlderThan(recent, time - RECENT_MS);

  const minuteStart = time - (time % MINUTE_MS);
  if (currentMinute && currentMinute.start !== minuteStart) finishMinute();
  currentMinute ??= { start: minuteStart, total: 0, count: 0 };
  currentMinute.total += tempC;
  currentMinute.count += 1;
};

const loadHistory = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const cutoff = Date.now() - DAY_MS;
    minutes = saved.minutes.filter(
      (minute) => Number.isFinite(minute.time) && Number.isFinite(minute.tempC) && minute.time >= cutoff
    );
  } catch (err) {
    // No file yet is normal on the first run; anything else means the file is damaged
    if (err.code !== 'ENOENT') console.error(`Starting with no temperature history: ${HISTORY_FILE} is unreadable (${err.message})`);
  }
};

// Write a temporary file and then rename it, so a power cut mid-save can't leave half a file
const saveHistory = () => {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(`${HISTORY_FILE}.tmp`, JSON.stringify({ minutes }));
    fs.renameSync(`${HISTORY_FILE}.tmp`, HISTORY_FILE);
  } catch (err) {
    console.error(`Could not save the temperature history: ${err.message}`);
  }
};

/**************************************************************
Main logic
***************************************************************/

// Called once from server.js. The timers don't keep Node running on their own (unref), so scripts
// and tests that load this file can still exit.
exports.startHistory = () => {
  loadHistory();
  takeSample();
  setInterval(takeSample, SAMPLE_MS).unref();
  setInterval(saveHistory, SAVE_EVERY_MS).unref();

  // `systemctl --user stop/restart` sends SIGTERM and Ctrl+C sends SIGINT: save before exiting
  ['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.once(signal, () => {
      saveHistory();
      process.exit(0);
    });
  });
};

/**************************************************************
Handlers
***************************************************************/

exports.getHistory = async (req, res) => {
  res.json({ recent, minutes });
};
