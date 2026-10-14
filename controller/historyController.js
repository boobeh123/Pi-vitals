const fs = require('node:fs');
const path = require('node:path');
const { parsers } = require('./vitalsController');

const THERMAL_PATH = '/sys/class/thermal/thermal_zone0/temp';
const MEMINFO_PATH = '/proc/meminfo';
// data/ is gitignored. Only the minute averages are saved; the 2-second readings are rebuilt within
// 5 minutes. HISTORY_FILE can point somewhere else; the tests use it to stay away from the real file.
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, '..', 'data', 'history.json');

const SAMPLE_MS = 2000; // the same pace as the dashboard's polls
const MINUTE_MS = 60 * 1000;
const RECENT_MS = 5 * MINUTE_MS; // 2-second readings kept for the 5-minute chart
const DAY_MS = 24 * 60 * MINUTE_MS; // minute averages kept for the 1-hour and 24-hour charts
const SAVE_EVERY_MS = 10 * MINUTE_MS;

// What each reading records. Any of them can be null: a sensor that couldn't be read, a Pi with
// no swap, or minutes saved before memory was recorded (Oct 2026), which only have tempC.
const FIELDS = ['tempC', 'memPercent', 'swapPercent'];

const recent = []; // { time, tempC, memPercent, swapPercent } every 2 seconds, newest last
let minutes = []; // the same, one average per minute, stamped at the middle of its minute
let currentMinute = null; // running totals for the minute being averaged

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

const roundTo = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

// Memory in use (total minus available, like the Memory card) and swap in use, as percentages
const readMemory = () => {
  try {
    const memory = parsers.parseMeminfo(fs.readFileSync(MEMINFO_PATH, 'utf8'));
    return {
      memPercent: roundTo((memory.usedMb / memory.totalMb) * 100, 1),
      swapPercent: memory.swapTotalMb > 0 ? roundTo((memory.swapUsedMb / memory.swapTotalMb) * 100, 1) : null,
    };
  } catch {
    return { memPercent: null, swapPercent: null };
  }
};

const dropOlderThan = (samples, cutoff) => {
  while (samples.length > 0 && samples[0].time < cutoff) samples.shift();
};

// Store the finished minute's averages, then forget anything older than a day
const finishMinute = () => {
  const average = { time: currentMinute.start + MINUTE_MS / 2 };
  FIELDS.forEach((field) => {
    const { total, count } = currentMinute.sums[field];
    average[field] = count > 0 ? roundTo(total / count, field === 'tempC' ? 2 : 1) : null;
  });
  minutes.push(average);
  currentMinute = null;
  dropOlderThan(minutes, Date.now() - DAY_MS);
};

const takeSample = () => {
  const sample = { time: Date.now(), tempC: readTempC(), ...readMemory() };
  if (FIELDS.every((field) => sample[field] === null)) return;

  recent.push(sample);
  dropOlderThan(recent, sample.time - RECENT_MS);

  const minuteStart = sample.time - (sample.time % MINUTE_MS);
  if (currentMinute && currentMinute.start !== minuteStart) finishMinute();
  currentMinute ??= {
    start: minuteStart,
    sums: Object.fromEntries(FIELDS.map((field) => [field, { total: 0, count: 0 }])),
  };
  FIELDS.filter((field) => sample[field] !== null).forEach((field) => {
    currentMinute.sums[field].total += sample[field];
    currentMinute.sums[field].count += 1;
  });
};

const loadHistory = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const cutoff = Date.now() - DAY_MS;
    // Keep minutes from the last day that have at least one reading, and fill in null for missing ones
    minutes = saved.minutes
      .filter((minute) => Number.isFinite(minute.time) && minute.time >= cutoff)
      .map((minute) => ({
        time: minute.time,
        ...Object.fromEntries(FIELDS.map((field) => [field, Number.isFinite(minute[field]) ? minute[field] : null])),
      }))
      .filter((minute) => FIELDS.some((field) => minute[field] !== null));
  } catch (err) {
    // No file yet is normal on the first run; anything else means the file is damaged
    if (err.code !== 'ENOENT') console.error(`Starting with no history: ${HISTORY_FILE} is unreadable (${err.message})`);
  }
};

// Write a temporary file and then rename it, so a power cut mid-save can't leave half a file
const saveHistory = () => {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(`${HISTORY_FILE}.tmp`, JSON.stringify({ minutes }));
    fs.renameSync(`${HISTORY_FILE}.tmp`, HISTORY_FILE);
  } catch (err) {
    console.error(`Could not save the history: ${err.message}`);
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
