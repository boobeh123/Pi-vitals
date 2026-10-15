/**************************************************************
DOM selectors
***************************************************************/
const root = document.documentElement;
const liveStatus = document.querySelector('.liveStatus');
const liveText = document.querySelector('.liveText');

const tempValue = document.querySelector('.tempValue');
const tempPill = document.querySelector('.tempSection .statusPill');

// The parts of one history chart, found inside its section
const selectChart = (section) => ({
  rangeInputs: document.querySelectorAll(`${section} .rangePicker input`),
  rangeLabel: document.querySelector(`${section} .rangeLabel`),
  summary: document.querySelector(`${section} .chartSummary`),
  svg: document.querySelector(`${section} .sparkline`),
  grid: document.querySelector(`${section} .chartGrid`),
  lines: document.querySelectorAll(`${section} .sparkLine`), // one per series, in the same order
  crosshair: document.querySelector(`${section} .crosshair`),
  hoverDot: document.querySelector(`${section} .hoverDot`),
  latestDot: document.querySelector(`${section} .latestDot`),
  tooltip: document.querySelector(`${section} .chartTooltip`),
});
const tempChartParts = selectChart('.tempSection');
const memoryChartParts = selectChart('.memorySection');

const fanRpm = document.querySelector('.fanRpm');
const fanPercent = document.querySelector('.fanPercent');
const cpuFreq = document.querySelector('.cpuFreq');
const loadNow = document.querySelector('.loadNow');
const load5 = document.querySelector('.load5');
const load15 = document.querySelector('.load15');
const coreCount = document.querySelector('.coreCount');
const memUsed = document.querySelector('.memUsed');
const memTotal = document.querySelector('.memTotal');
const memMeter = document.querySelector('.memMeter');
const memMeterFill = document.querySelector('.memMeter .meterFill');
const swapNote = document.querySelector('.swapNote');
const diskUsed = document.querySelector('.diskUsed');
const diskTotal = document.querySelector('.diskTotal');
const diskMeter = document.querySelector('.diskMeter');
const diskMeterFill = document.querySelector('.diskMeter .meterFill');
const diskNote = document.querySelector('.diskNote');
const uptime = document.querySelector('.uptime');
const healthPill = document.querySelector('.healthPill');
const healthNote = document.querySelector('.healthNote');
const restartPill = document.querySelector('.restartPill');
const restartNote = document.querySelector('.restartNote');
const restartBooted = document.querySelector('.restartBooted');
const adguardPill = document.querySelector('.adguardPill');
const adguardNote = document.querySelector('.adguardNote');
const adguardChecked = document.querySelector('.adguardChecked');
const wifiPill = document.querySelector('.wifiPill');
const wifiNote = document.querySelector('.wifiNote');
const netDown = document.querySelector('.netDown');
const netUp = document.querySelector('.netUp');
const processRows = document.querySelector('.processRows');

/**************************************************************
Settings and state
***************************************************************/
const POLL_MS = 2000;
const MINUTE_MS = 60 * 1000;

// The chart's ranges. The 5-minute chart uses readings 2 seconds apart; the longer ones use the
// server's one-a-minute averages. Readings further apart than gapMs get a gap in the line instead
// of a straight join, for example while the Pi was off or the server couldn't be reached.
const CHART_RANGES = {
  '5m': { windowMs: 5 * MINUTE_MS, gapMs: POLL_MS * 3, label: 'Last 5 minutes' },
  '1h': { windowMs: 60 * MINUTE_MS, gapMs: 3 * MINUTE_MS, label: 'Last hour' },
  '24h': { windowMs: 24 * 60 * MINUTE_MS, gapMs: 3 * MINUTE_MS, label: 'Last 24 hours' },
};
// The longer charts gain one reading a minute, so there's no point fetching them more often
const HISTORY_REFRESH_MS = MINUTE_MS;

const CHART_HEIGHT = 140;
const CHART_PAD = { top: 8, right: 8, bottom: 8, left: 38 };
const SVG_NS = 'http://www.w3.org/2000/svg';

// The real fan spins ~2000+ RPM, which would just look like a blur.
// Show it at 1/40 speed so faster still clearly means faster.
const FAN_VISUAL_SCALE = 40;

// AdGuard normally answers in well under 100 ms; a second or more is slow enough to notice in a browser
const SLOW_DNS_MS = 1000;

// The storage meter turns amber, then red, as the drive fills up
const DISK_WARNING_PERCENT = 80;
const DISK_CRITICAL_PERCENT = 90;

// The history charts. Each reading has every series' key (null when it wasn't recorded); the first
// series gets the newest-reading dot and the hover dot. range is the picked range and changes.
const CHARTS = [
  {
    parts: tempChartParts,
    name: 'CPU temperature',
    series: [{ key: 'tempC' }],
    range: '5m',
    // Gridlines every 5 °C around the readings, at least 10 °C tall
    getYAxis: (values) => {
      let low = Math.floor(Math.min(...values) / 5) * 5;
      let high = Math.ceil(Math.max(...values) / 5) * 5;
      if (high - low < 10) {
        const middle = (high + low) / 2;
        low = Math.floor((middle - 5) / 5) * 5;
        high = low + 10;
      }
      return { low, high, step: 5 };
    },
    formatTick: (degrees) => `${degrees}°`,
    formatReading: (sample) => `${sample.tempC.toFixed(1)} °C`,
    summarize: (samples) => {
      const temps = samples.map((sample) => sample.tempC).filter((tempC) => tempC !== null);
      return `low ${Math.min(...temps).toFixed(1)} °C / high ${Math.max(...temps).toFixed(1)} °C`;
    },
  },
  {
    parts: memoryChartParts,
    name: 'Memory and swap in use',
    series: [{ key: 'memPercent' }, { key: 'swapPercent' }],
    range: '5m',
    // Always the whole 0-100%, so a full Pi looks full
    getYAxis: () => ({ low: 0, high: 100, step: 25 }),
    formatTick: (percent) => `${percent}%`,
    formatReading: (sample) =>
      [
        sample.memPercent !== null && `memory ${sample.memPercent.toFixed(0)}%`,
        sample.swapPercent !== null && `swap ${sample.swapPercent.toFixed(0)}%`,
      ]
        .filter(Boolean)
        .join(', '),
    summarize: (samples) => {
      const peak = (key) => Math.max(...samples.map((sample) => sample[key]).filter((value) => value !== null));
      const memPeak = peak('memPercent');
      const swapPeak = peak('swapPercent');
      return [
        Number.isFinite(memPeak) && `memory peak ${memPeak.toFixed(0)}%`,
        Number.isFinite(swapPeak) && `swap peak ${swapPeak.toFixed(0)}%`,
      ]
        .filter(Boolean)
        .join(' / ');
    },
  },
];

const recentHistory = []; // readings 2 seconds apart for the 5-minute charts, newest last
let minuteHistory = []; // the server's one-a-minute averages for the last 24 hours
let latestTime = 0; // server time of the newest reading: the charts' right edge
let historyFetchedAt = 0;
let lastSpinRpm = 0;
let lastNetwork = null; // previous byte counters, for working out speeds
let pollTimer = null;
let pollInFlight = false;

/**************************************************************
Helpers
***************************************************************/
const STATUS_ICONS = { good: '✓', warning: '!', serious: '!', critical: '✕', unknown: '•' };

const setPill = (pill, status, text) => {
  pill.dataset.status = status;
  pill.querySelector('.statusIcon').textContent = STATUS_ICONS[status];
  pill.querySelector('.statusText').textContent = text;
};

const getTempStatus = (tempC) => {
  if (tempC < 60) return { status: 'good', text: 'Cool' };
  if (tempC < 70) return { status: 'warning', text: 'Warm' };
  if (tempC < 80) return { status: 'serious', text: 'Hot' };
  return { status: 'critical', text: 'Very hot: near throttling (85 °C)' };
};

const formatUptime = (totalSec) => {
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const parts = [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes}m`];
  return parts.filter(Boolean).join(' ');
};

// Bytes to GB the way `df -h` and the memory card count them (1 GB = 1024³ bytes)
const formatGb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

const getDiskStatus = (percent) => {
  if (percent >= DISK_CRITICAL_PERCENT) return 'critical';
  if (percent >= DISK_WARNING_PERCENT) return 'warning';
  return 'normal';
};

const formatRate = (bytesPerSec) => {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
};

// Rough Wi-Fi signal bands in dBm (closer to 0 is stronger)
const getSignalStatus = (dbm) => {
  if (dbm >= -50) return { status: 'good', text: 'Excellent' };
  if (dbm >= -65) return { status: 'good', text: 'Good' };
  if (dbm >= -75) return { status: 'warning', text: 'Fair' };
  return { status: 'serious', text: 'Weak' };
};

const formatDuration = (ms) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const formatAgo = (ms) => `${formatDuration(ms)} ago`;

// "Sun, Oct 11, 12:42 AM" in the browser's own language
const formatDateTime = (ms) =>
  new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const createSvg = (tag, attributes) => {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
};

const toPercent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// The readings a chart's selected range shows
const getChartSamples = (chart) => {
  if (chart.range === '5m') return recentHistory;
  const { windowMs } = CHART_RANGES[chart.range];
  return minuteHistory.filter((sample) => sample.time >= latestTime - windowMs);
};

// Every value any of the chart's series has in these readings
const getChartValues = (chart, samples) =>
  samples.flatMap((sample) => chart.series.map((series) => sample[series.key])).filter((value) => value !== null);

// Turns readings into pixel positions for the chart's current width
const getChartScale = (chart, values) => {
  const width = chart.parts.svg.clientWidth;
  const { low, high, step } = chart.getYAxis(values);
  const plotWidth = width - CHART_PAD.left - CHART_PAD.right;
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const { windowMs } = CHART_RANGES[chart.range];

  return {
    width,
    low,
    high,
    step,
    // Readings sit by time: the newest moment on the right edge, the start of the range on the left
    toX: (time) => CHART_PAD.left + plotWidth * (1 - (latestTime - time) / windowMs),
    toY: (value) => CHART_PAD.top + plotHeight * (1 - (value - low) / (high - low)),
  };
};

/**************************************************************
Render functions
***************************************************************/
const renderChart = (chart) => {
  const { svg, grid, lines, latestDot, summary } = chart.parts;
  const samples = getChartSamples(chart);
  const values = getChartValues(chart, samples);
  if (values.length === 0) {
    // For example the hour chart in the first minute after the server starts
    grid.replaceChildren();
    lines.forEach((line) => line.setAttribute('d', ''));
    latestDot.setAttribute('cx', -10);
    latestDot.setAttribute('cy', -10);
    summary.textContent = 'no readings yet';
    return;
  }

  const { width, low, high, step, toX, toY } = getChartScale(chart, values);
  const { gapMs } = CHART_RANGES[chart.range];
  svg.setAttribute('viewBox', `0 0 ${width} ${CHART_HEIGHT}`);

  // Gridlines every step, labeled on the left
  grid.replaceChildren();
  for (let value = low; value <= high; value += step) {
    const y = toY(value);
    grid.append(createSvg('line', { x1: CHART_PAD.left, x2: width - CHART_PAD.right, y1: y, y2: y }));
    const label = createSvg('text', { x: 0, y: y + 4 });
    label.textContent = chart.formatTick(value);
    grid.append(label);
  }

  // One line per series. "M" starts a new piece of line, so missing readings show as a gap
  // rather than a straight join.
  chart.series.forEach((series, index) => {
    const points = samples.filter((sample) => sample[series.key] !== null);
    const pathData = points
      .map((sample, pointIndex) => {
        const startsPiece = pointIndex === 0 || sample.time - points[pointIndex - 1].time > gapMs;
        return `${startsPiece ? 'M' : 'L'}${toX(sample.time).toFixed(1)} ${toY(sample[series.key]).toFixed(1)}`;
      })
      .join(' ');
    lines[index].setAttribute('d', pathData);
  });

  // Mark the newest reading of the first series, so the very first one is visible before there's a line
  const mainKey = chart.series[0].key;
  const latest = samples.findLast((sample) => sample[mainKey] !== null);
  latestDot.setAttribute('cx', latest ? toX(latest.time) : -10);
  latestDot.setAttribute('cy', latest ? toY(latest[mainKey]) : -10);

  summary.textContent = chart.summarize(samples);
};

const renderCharts = () => CHARTS.forEach(renderChart);

const renderFan = (fan) => {
  if (!fan) {
    fanRpm.textContent = 'n/a';
    fanPercent.textContent = '--';
    return;
  }
  fanRpm.textContent = fan.rpm.toLocaleString();
  fanPercent.textContent = fan.percent;

  // Only retime the spin when speed changes noticeably, so the blades don't jump every poll
  if (Math.abs(fan.rpm - lastSpinRpm) > lastSpinRpm * 0.1) {
    lastSpinRpm = fan.rpm;
    const secondsPerTurn = fan.rpm > 0 ? 60 / (fan.rpm / FAN_VISUAL_SCALE) : 0;
    root.style.setProperty('--spinDuration', `${secondsPerTurn.toFixed(2)}s`);
  }
};

const renderDisk = (disk) => {
  if (!disk) {
    diskUsed.textContent = 'n/a';
    diskNote.textContent = 'Could not read the drive.';
    return;
  }
  diskUsed.textContent = formatGb(disk.usedBytes);
  diskTotal.textContent = formatGb(disk.totalBytes);
  diskMeterFill.style.width = `${disk.usedPercent}%`;
  diskMeter.setAttribute('aria-valuenow', disk.usedPercent);
  diskMeter.dataset.status = getDiskStatus(disk.usedPercent);
  diskNote.textContent = [`${formatGb(disk.freeBytes)} GB free`, disk.kind].filter(Boolean).join(' · ');
};

const renderHealth = (throttling) => {
  if (!throttling) {
    setPill(healthPill, 'unknown', 'Unavailable');
    healthNote.textContent = 'vcgencmd could not be read.';
    return;
  }
  if (throttling.now.length > 0) {
    setPill(healthPill, 'critical', 'Problem now');
    healthNote.textContent = throttling.now.join(', ');
    return;
  }
  if (throttling.sinceBoot.length > 0) {
    setPill(healthPill, 'warning', 'Earlier since boot');
    healthNote.textContent = throttling.sinceBoot.join(', ');
    return;
  }
  setPill(healthPill, 'good', 'All clear');
  healthNote.textContent = 'No under-voltage or throttling since boot.';
};

// How the Pi's last run ended, judged by the server from the system log
const renderRestart = (lastRestart) => {
  restartBooted.textContent = `Started ${formatDateTime(lastRestart.bootedAt)}`;
  const { previous, powerReset } = lastRestart;

  // The power chip (PMIC) records why it reset; it's empty after a normal power-on or reboot
  if (powerReset && powerReset.length > 0) {
    setPill(restartPill, 'warning', 'Power chip reset');
    restartNote.textContent = `Reason: ${powerReset.join(', ')}.`;
  } else if (!lastRestart.logReadable) {
    setPill(restartPill, 'unknown', 'Unavailable');
    restartNote.textContent = 'The system log could not be read.';
  } else if (!previous) {
    setPill(restartPill, 'unknown', 'No earlier start');
    restartNote.textContent = 'The system log begins with this start, so there is nothing to compare yet.';
  } else if (previous.clean) {
    setPill(restartPill, 'good', 'Clean restart');
    restartNote.textContent = `Shut down normally on ${formatDateTime(previous.endedAt)}.`;
  } else {
    setPill(restartPill, 'warning', 'Unexpected stop');
    const downFor = formatDuration(lastRestart.bootedAt - previous.endedAt);
    restartNote.textContent = `The log stopped on ${formatDateTime(previous.endedAt)} without a shutdown (a freeze, crash or power cut). Back ${downFor} later.`;
  }
};

const renderAdguard = (service, dnsCheck, time) => {
  // The non-breaking space keeps "19 ms" together when the note wraps
  adguardNote.textContent = dnsCheck.ok
    ? `Looked up ${dnsCheck.domain} in ${dnsCheck.ms}\u00a0ms`
    : `Lookup failed: ${dnsCheck.error}`;
  // The lookup runs once a minute, so say how fresh the result is
  adguardChecked.textContent = `Checked ${formatAgo(time - dnsCheck.checkedAt)}`;

  // A running service isn't enough: it also has to answer the test lookup
  if (service !== 'active') {
    setPill(adguardPill, 'critical', `Not running (${service})`);
  } else if (!dnsCheck.ok) {
    setPill(adguardPill, 'critical', 'Not answering');
  } else if (dnsCheck.ms >= SLOW_DNS_MS) {
    setPill(adguardPill, 'warning', 'Slow');
  } else {
    setPill(adguardPill, 'good', 'Answering');
  }
};

const renderNetwork = (network, time) => {
  if (!network) {
    setPill(wifiPill, 'unknown', 'Unavailable');
    return;
  }

  if (network.signalDbm === null) {
    setPill(wifiPill, 'unknown', 'No Wi-Fi link');
    wifiNote.textContent = '';
  } else {
    const { status, text } = getSignalStatus(network.signalDbm);
    setPill(wifiPill, status, text);
    wifiNote.textContent = `${network.signalDbm} dBm · ${network.linkPercent}% link quality`;
  }

  // Speed = bytes moved since the last poll / seconds since the last poll
  if (lastNetwork) {
    const seconds = (time - lastNetwork.time) / 1000;
    netDown.textContent = formatRate((network.rxBytes - lastNetwork.rxBytes) / seconds);
    netUp.textContent = formatRate((network.txBytes - lastNetwork.txBytes) / seconds);
  }
  lastNetwork = { time, rxBytes: network.rxBytes, txBytes: network.txBytes };
};

const createRow = (cells, colSpan) => {
  const row = document.createElement('tr');
  if (colSpan) cells[0].colSpan = colSpan;
  row.append(...cells);
  return row;
};

const createCell = (text, className) => {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
};

const renderProcesses = (processes) => {
  // The server needs two polls to measure CPU use, so the first response has nothing yet
  if (!processes) {
    processRows.replaceChildren(createRow([createCell('Measuring…', 'processEmpty')], 3));
    return;
  }

  const rows = processes.map((proc) => {
    const name = proc.count > 1 ? `${proc.name} ×${proc.count}` : proc.name;
    const cpuCell = createCell(`${proc.cpuPercent.toFixed(1)}%`, 'numberCol');
    const bar = document.createElement('span');
    bar.className = 'cpuBar';
    bar.style.width = `${Math.min(proc.cpuPercent, 100)}%`;
    cpuCell.prepend(bar);
    return createRow([createCell(name, 'processName'), cpuCell, createCell(`${proc.memoryMb} MB`, 'numberCol')]);
  });
  processRows.replaceChildren(...rows);
};

const renderVitals = (vitals) => {
  if (vitals.cpuTempC !== null) {
    tempValue.textContent = vitals.cpuTempC.toFixed(1);
    const { status, text } = getTempStatus(vitals.cpuTempC);
    setPill(tempPill, status, text);
  }

  // The same reading the server records for its history, so live and fetched readings match
  latestTime = Math.max(latestTime, vitals.time);
  recentHistory.push({
    time: vitals.time,
    tempC: vitals.cpuTempC,
    memPercent: toPercent(vitals.memory.usedMb, vitals.memory.totalMb),
    swapPercent: toPercent(vitals.memory.swapUsedMb, vitals.memory.swapTotalMb),
  });
  // Keep only what the 5-minute charts show
  while (recentHistory[0].time < vitals.time - CHART_RANGES['5m'].windowMs) recentHistory.shift();
  renderCharts();

  renderFan(vitals.fan);
  cpuFreq.textContent = vitals.cpuFreqMhz ?? 'n/a';

  const [oneMin, fiveMin, fifteenMin] = vitals.load;
  loadNow.textContent = oneMin.toFixed(2);
  load5.textContent = fiveMin.toFixed(2);
  load15.textContent = fifteenMin.toFixed(2);
  coreCount.textContent = vitals.cores;

  const memPercent = Math.round((vitals.memory.usedMb / vitals.memory.totalMb) * 100);
  memUsed.textContent = (vitals.memory.usedMb / 1024).toFixed(1);
  memTotal.textContent = (vitals.memory.totalMb / 1024).toFixed(1);
  memMeterFill.style.width = `${memPercent}%`;
  memMeter.setAttribute('aria-valuenow', memPercent);
  swapNote.textContent = vitals.memory.swapTotalMb > 0
    ? `Swap ${(vitals.memory.swapUsedMb / 1024).toFixed(1)} / ${(vitals.memory.swapTotalMb / 1024).toFixed(1)} GB`
    : 'No swap';
  renderDisk(vitals.disk);

  uptime.textContent = formatUptime(vitals.uptimeSec);
  renderHealth(vitals.throttling);
  renderRestart(vitals.lastRestart);

  renderAdguard(vitals.adguard, vitals.dnsCheck, vitals.time);
  renderNetwork(vitals.network, vitals.time);
  renderProcesses(vitals.topProcesses);
};

/**************************************************************
Main logic
***************************************************************/
// The next poll waits until this one finishes, so requests never pile up. A hidden tab doesn't
// poll at all: each poll makes the Pi read the stats of every running process.
const scheduleNextPoll = () => {
  clearTimeout(pollTimer);
  if (!document.hidden) pollTimer = setTimeout(pollVitals, POLL_MS);
};

const pollVitals = async () => {
  pollInFlight = true;
  try {
    const response = await fetch('/api/vitals');
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    const vitals = await response.json();

    renderVitals(vitals);
    liveStatus.classList.add('isLive');
    liveStatus.classList.remove('isOffline');
    liveText.textContent = `Live · ${new Date(vitals.time).toLocaleTimeString()}`;
    const showingLongRange = CHARTS.some((chart) => chart.range !== '5m');
    if (showingLongRange && Date.now() - historyFetchedAt >= HISTORY_REFRESH_MS) fetchHistory();
  } catch (err) {
    console.error(err);
    liveStatus.classList.remove('isLive');
    liveStatus.classList.add('isOffline');
    liveText.textContent = 'Lost connection, retrying…';
  } finally {
    pollInFlight = false;
    scheduleNextPoll();
  }
};

// The server records readings even while no page is open or this tab is hidden,
// so its readings fill in the charts on load and when the tab comes back
const fetchHistory = async () => {
  historyFetchedAt = Date.now();
  try {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    const { recent, minutes } = await response.json();

    // Keep any live readings newer than the server's newest one
    const newestServerTime = recent.at(-1)?.time ?? 0;
    const newerLive = recentHistory.filter((sample) => sample.time > newestServerTime);
    recentHistory.splice(0, recentHistory.length, ...recent, ...newerLive);
    minuteHistory = minutes;
    latestTime = Math.max(latestTime, newestServerTime);
    renderCharts();
  } catch (err) {
    console.error(err);
  }
};

const setChartRange = (chart, range) => {
  chart.range = range;
  const { label } = CHART_RANGES[range];
  chart.parts.rangeLabel.textContent = label;
  chart.parts.svg.setAttribute('aria-label', `${chart.name} over the ${label.toLowerCase()}`);
  if (range !== '5m' && Date.now() - historyFetchedAt >= HISTORY_REFRESH_MS) fetchHistory();
  renderChart(chart);
};

const handleRangeChange = (chart, event) => {
  handleChartLeave(chart); // the tooltip belonged to the old range
  setChartRange(chart, event.target.value);
};

const handleVisibilityChange = () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    return;
  }
  // Back in view. An average speed over the hidden time isn't a live speed, so wait for two fresh readings.
  lastNetwork = null;
  netDown.textContent = '--';
  netUp.textContent = '--';
  if (!pollInFlight) pollVitals();
  fetchHistory();
};

const handleChartHover = (chart, event) => {
  const { svg, crosshair, hoverDot, tooltip } = chart.parts;
  const samples = getChartSamples(chart).filter((sample) => getChartValues(chart, [sample]).length > 0);
  if (samples.length === 0) return;
  const { toX, toY } = getChartScale(chart, getChartValues(chart, samples));
  const bounds = svg.getBoundingClientRect();
  const mouseX = event.clientX - bounds.left;

  const nearest = samples.reduce((best, sample) =>
    Math.abs(toX(sample.time) - mouseX) < Math.abs(toX(best.time) - mouseX) ? sample : best
  );
  const x = toX(nearest.time);
  const mainValue = nearest[chart.series[0].key];

  crosshair.setAttribute('x1', x);
  crosshair.setAttribute('x2', x);
  hoverDot.setAttribute('cx', mainValue === null ? -10 : x);
  hoverDot.setAttribute('cy', mainValue === null ? -10 : toY(mainValue));
  svg.classList.add('isHovering');

  // The 5-minute charts say how long ago; the longer ones show the clock time of each minute's average
  if (chart.range === '5m') {
    const age = latestTime - nearest.time;
    tooltip.textContent = `${chart.formatReading(nearest)} · ${age === 0 ? 'now' : formatAgo(age)}`;
  } else {
    const clockTime = new Date(nearest.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    tooltip.textContent = `${chart.formatReading(nearest)} average · ${clockTime}`;
  }
  // Centered on the reading, but kept inside the chart (it's only measurable once shown)
  tooltip.hidden = false;
  const halfWidth = tooltip.offsetWidth / 2;
  tooltip.style.left = `${Math.min(Math.max(x, halfWidth), bounds.width - halfWidth)}px`;
};

const handleChartLeave = (chart) => {
  chart.parts.svg.classList.remove('isHovering');
  chart.parts.tooltip.hidden = true;
};

/**************************************************************
Event listeners
***************************************************************/
CHARTS.forEach((chart) => {
  chart.parts.svg.addEventListener('pointermove', (event) => handleChartHover(chart, event));
  chart.parts.svg.addEventListener('pointerleave', () => handleChartLeave(chart));
  chart.parts.rangeInputs.forEach((input) => input.addEventListener('change', (event) => handleRangeChange(chart, event)));
});
window.addEventListener('resize', renderCharts);
document.addEventListener('visibilitychange', handleVisibilityChange);

fetchHistory();
// Some browsers restore the last picked range on reload, so start from whichever is checked
CHARTS.forEach((chart) => {
  const checked = [...chart.parts.rangeInputs].find((input) => input.checked);
  setChartRange(chart, checked.value);
});
pollVitals();
