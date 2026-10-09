const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const THERMAL_PATH = '/sys/class/thermal/thermal_zone0/temp';
const CPU_FREQ_PATH = '/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq';
const FAN_HWMON_DIR = '/sys/devices/platform/cooling_fan/hwmon';
const WIFI_INTERFACE = 'wlan0';
const TOP_PROCESS_COUNT = 5;

// Bits from `vcgencmd get_throttled`. Low bits are "right now", bits 16+ are "since boot".
const THROTTLE_FLAGS = [
  { bit: 0, label: 'Under-voltage' },
  { bit: 1, label: 'Clock capped' },
  { bit: 2, label: 'Throttled' },
  { bit: 3, label: 'Soft temperature limit' },
];

/**************************************************************
Helpers
***************************************************************/

// Read a sysfs file and return it as a number, or null if the file is missing
const readNumber = async (filePath) => {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return Number(text.trim());
  } catch {
    return null;
  }
};

// The fan's hwmon folder name (hwmon2, hwmon3...) can change between boots, so look it up
const getFanDir = async () => {
  try {
    const entries = await fs.readdir(FAN_HWMON_DIR);
    const hwmon = entries.find((entry) => entry.startsWith('hwmon'));
    return hwmon ? path.join(FAN_HWMON_DIR, hwmon) : null;
  } catch {
    return null;
  }
};

const getFan = async () => {
  const fanDir = await getFanDir();
  if (!fanDir) return null;

  const [rpm, pwm] = await Promise.all([
    readNumber(path.join(fanDir, 'fan1_input')),
    readNumber(path.join(fanDir, 'pwm1')),
  ]);

  // pwm1 is 0-255; convert to a percentage of full speed
  return { rpm, percent: pwm === null ? null : Math.round((pwm / 255) * 100) };
};

const getMemory = async () => {
  const text = await fs.readFile('/proc/meminfo', 'utf8');
  const lines = text.split('\n');
  const readKb = (key) => {
    const line = lines.find((entry) => entry.startsWith(`${key}:`));
    return line ? Number(line.split(/\s+/)[1]) : 0;
  };

  const totalMb = Math.round(readKb('MemTotal') / 1024);
  const availableMb = Math.round(readKb('MemAvailable') / 1024);
  return { totalMb, usedMb: totalMb - availableMb };
};

const getThrottling = async () => {
  try {
    const { stdout } = await execFileAsync('vcgencmd', ['get_throttled']);
    // Output looks like "throttled=0x50000"
    const value = parseInt(stdout.trim().split('=')[1], 16);
    const isSet = (bit) => (value & (1 << bit)) !== 0;

    return {
      now: THROTTLE_FLAGS.filter((flag) => isSet(flag.bit)).map((flag) => flag.label),
      sinceBoot: THROTTLE_FLAGS.filter((flag) => isSet(flag.bit + 16)).map((flag) => flag.label),
    };
  } catch {
    return null;
  }
};

// Wi-Fi signal from /proc/net/wireless and byte counters from /proc/net/dev.
// The browser turns the byte counters into speeds by comparing two polls.
const getNetwork = async () => {
  try {
    const [wirelessText, devText] = await Promise.all([
      fs.readFile('/proc/net/wireless', 'utf8'),
      fs.readFile('/proc/net/dev', 'utf8'),
    ]);
    const findLine = (text) =>
      text.split('\n').find((line) => line.trim().startsWith(`${WIFI_INTERFACE}:`));

    // wireless columns: interface, status, link quality (out of 70), signal level (dBm), ...
    const wirelessLine = findLine(wirelessText);
    const wireless = wirelessLine ? wirelessLine.trim().split(/\s+/) : null;

    // dev columns after the interface: received bytes is 1st, transmitted bytes is 9th
    const devFields = findLine(devText).split(':')[1].trim().split(/\s+/);

    return {
      linkPercent: wireless ? Math.round((parseFloat(wireless[2]) / 70) * 100) : null,
      signalDbm: wireless ? parseFloat(wireless[3]) : null,
      rxBytes: Number(devFields[0]),
      txBytes: Number(devFields[8]),
    };
  } catch {
    return null;
  }
};

// Page size and clock ticks per second, asked from the system once.
// The Pi 5 kernel uses 16 KB pages, so assuming the usual 4 KB would under-report memory 4x.
const systemConstantsPromise = Promise.all([
  execFileAsync('getconf', ['PAGESIZE']),
  execFileAsync('getconf', ['CLK_TCK']),
]).then(([pageSize, clockTicks]) => ({
  pageSize: Number(pageSize.stdout),
  clockTicks: Number(clockTicks.stdout),
}));

// CPU time used so far by each process, from the previous poll
let lastProcessSample = null;

const readProcess = async (pid) => {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    // The name sits in parentheses and can contain spaces, so split after the last ")"
    const close = stat.lastIndexOf(')');
    const name = stat.slice(stat.indexOf('(') + 1, close);
    const fields = stat.slice(close + 2).split(' ');
    // After the name: utime and stime (CPU ticks) are fields 12-13, resident pages field 22
    return {
      pid,
      name,
      ticks: Number(fields[11]) + Number(fields[12]),
      residentPages: Number(fields[21]),
    };
  } catch {
    return null; // the process exited while we were reading it
  }
};

// Current CPU use per program, worked out from how much CPU time each process used since the last poll
// (ps only reports an average over each process's whole life). Processes with the same name are grouped,
// so a browser's dozen helper processes show up as one line.
const getTopProcesses = async () => {
  try {
    const { pageSize, clockTicks } = await systemConstantsPromise;
    const pids = (await fs.readdir('/proc')).filter((entry) => /^\d+$/.test(entry)); // numeric folders are processes
    const processes = (await Promise.all(pids.map(readProcess))).filter(Boolean);
    const now = Date.now();

    const previous = lastProcessSample;
    lastProcessSample = { time: now, ticks: new Map(processes.map((proc) => [proc.pid, proc.ticks])) };
    if (!previous) return null; // need two samples to measure

    const seconds = (now - previous.time) / 1000;
    const groups = processes.reduce((byName, proc) => {
      const previousTicks = previous.ticks.get(proc.pid) ?? proc.ticks; // new process: no usage counted yet
      const group = byName.get(proc.name) || { name: proc.name, cpuPercent: 0, memoryMb: 0, count: 0 };
      group.cpuPercent += ((proc.ticks - previousTicks) / clockTicks / seconds) * 100;
      group.memoryMb += (proc.residentPages * pageSize) / 1024 / 1024;
      group.count += 1;
      return byName.set(proc.name, group);
    }, new Map());

    return [...groups.values()]
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb)
      .slice(0, TOP_PROCESS_COUNT)
      .map((group) => ({
        ...group,
        cpuPercent: Math.round(group.cpuPercent * 10) / 10,
        memoryMb: Math.round(group.memoryMb),
      }));
  } catch {
    return null;
  }
};

const getServiceStatus = async (serviceName) => {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', serviceName]);
    return stdout.trim();
  } catch (err) {
    // is-active exits non-zero for inactive/failed services but still prints the state
    return err.stdout ? err.stdout.trim() : 'unknown';
  }
};

/**************************************************************
Handlers
***************************************************************/

exports.getDashboard = async (req, res) => {
  res.render('dashboard', { hostname: os.hostname() });
};

exports.getVitals = async (req, res) => {
  const [tempMilli, freqKhz, fan, memory, throttling, adguard, network, topProcesses] = await Promise.all([
    readNumber(THERMAL_PATH),
    readNumber(CPU_FREQ_PATH),
    getFan(),
    getMemory(),
    getThrottling(),
    getServiceStatus('AdGuardHome'),
    getNetwork(),
    getTopProcesses(),
  ]);

  res.json({
    time: Date.now(),
    cpuTempC: tempMilli === null ? null : tempMilli / 1000,
    cpuFreqMhz: freqKhz === null ? null : Math.round(freqKhz / 1000),
    cores: os.cpus().length,
    load: os.loadavg(),
    uptimeSec: Math.round(os.uptime()),
    fan,
    memory,
    throttling,
    adguard,
    network,
    topProcesses,
  });
};
