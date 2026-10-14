/**************************************************************
DOM selectors
***************************************************************/
const root = document.documentElement;
const liveStatus = document.querySelector('.liveStatus');
const liveText = document.querySelector('.liveText');

const tempValue = document.querySelector('.tempValue');
const tempPill = document.querySelector('.tempSection .statusPill');
const tempRange = document.querySelector('.tempRange');
const rangeLabel = document.querySelector('.rangeLabel');
const rangeInputs = document.querySelectorAll('input[name="chartRange"]');
const sparkline = document.querySelector('.sparkline');
const chartGrid = document.querySelector('.chartGrid');
const sparkLine = document.querySelector('.sparkLine');
const crosshair = document.querySelector('.crosshair');
const hoverDot = document.querySelector('.hoverDot');
const latestDot = document.querySelector('.latestDot');
const chartTooltip = document.querySelector('.chartTooltip');

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
const CHART_PAD = { top: 8, right: 8, bottom: 8, left: 34 };
const SVG_NS = 'http://www.w3.org/2000/svg';

// The real fan spins ~2000+ RPM, which would just look like a blur.
// Show it at 1/40 speed so faster still clearly means faster.
const FAN_VISUAL_SCALE = 40;

// AdGuard normally answers in well under 100 ms; a second or more is slow enough to notice in a browser
const SLOW_DNS_MS = 1000;

// The storage meter turns amber, then red, as the drive fills up
const DISK_WARNING_PERCENT = 80;
const DISK_CRITICAL_PERCENT = 90;

const tempHistory = []; // readings 2 seconds apart for the 5-minute chart, newest last
let minuteHistory = []; // the server's one-a-minute averages for the last 24 hours
let chartRange = '5m';
let latestTime = 0; // server time of the newest reading: the chart's right edge
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

const formatAgo = (ms) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
};

const createSvg = (tag, attributes) => {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
};

// Y axis covers the data rounded out to multiples of 5 °C, at least 10 °C tall
const getYRange = (temps) => {
  let low = Math.floor(Math.min(...temps) / 5) * 5;
  let high = Math.ceil(Math.max(...temps) / 5) * 5;
  if (high - low < 10) {
    const middle = (high + low) / 2;
    low = Math.floor((middle - 5) / 5) * 5;
    high = low + 10;
  }
  return { low, high };
};

// The readings the selected range shows
const getChartSamples = () => {
  if (chartRange === '5m') return tempHistory;
  const { windowMs } = CHART_RANGES[chartRange];
  return minuteHistory.filter((sample) => sample.time >= latestTime - windowMs);
};

// Map readings to pixel positions for the current chart width
const getChartPoints = (samples) => {
  const width = sparkline.clientWidth;
  const { low, high } = getYRange(samples.map((sample) => sample.tempC));
  const plotWidth = width - CHART_PAD.left - CHART_PAD.right;
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const { windowMs } = CHART_RANGES[chartRange];

  // Readings sit by time: the newest moment on the right edge, the start of the range on the left
  const points = samples.map((sample) => ({
    ...sample,
    x: CHART_PAD.left + plotWidth * (1 - (latestTime - sample.time) / windowMs),
    y: CHART_PAD.top + plotHeight * (1 - (sample.tempC - low) / (high - low)),
  }));

  return { width, low, high, plotHeight, points };
};

/**************************************************************
Render functions
***************************************************************/
const renderChart = () => {
  const samples = getChartSamples();
  if (samples.length === 0) {
    // For example the hour chart in the first minute after the server starts
    chartGrid.replaceChildren();
    sparkLine.setAttribute('d', '');
    latestDot.setAttribute('cx', -10);
    latestDot.setAttribute('cy', -10);
    tempRange.textContent = 'no readings yet';
    return;
  }

  const { width, low, high, plotHeight, points } = getChartPoints(samples);
  const { gapMs } = CHART_RANGES[chartRange];
  sparkline.setAttribute('viewBox', `0 0 ${width} ${CHART_HEIGHT}`);

  // Gridlines every 5 °C, labeled on the left
  chartGrid.replaceChildren();
  for (let degrees = low; degrees <= high; degrees += 5) {
    const y = CHART_PAD.top + plotHeight * (1 - (degrees - low) / (high - low));
    chartGrid.append(
      createSvg('line', { x1: CHART_PAD.left, x2: width - CHART_PAD.right, y1: y, y2: y })
    );
    const label = createSvg('text', { x: 0, y: y + 4 });
    label.textContent = `${degrees}°`;
    chartGrid.append(label);
  }

  // "M" starts a new piece of line, so missing readings show as a gap rather than a straight join
  const pathData = points
    .map((point, index) => {
      const startsPiece = index === 0 || point.time - points[index - 1].time > gapMs;
      return `${startsPiece ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(' ');
  sparkLine.setAttribute('d', pathData);

  // Mark the newest reading, so the very first one is visible before there's a line
  const latest = points[points.length - 1];
  latestDot.setAttribute('cx', latest.x);
  latestDot.setAttribute('cy', latest.y);

  const temps = samples.map((sample) => sample.tempC);
  tempRange.textContent = `low ${Math.min(...temps).toFixed(1)} °C / high ${Math.max(...temps).toFixed(1)} °C`;
};

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

    latestTime = Math.max(latestTime, vitals.time);
    tempHistory.push({ time: vitals.time, tempC: vitals.cpuTempC });
    // Keep only what the 5-minute chart shows
    while (tempHistory[0].time < vitals.time - CHART_RANGES['5m'].windowMs) tempHistory.shift();
    renderChart();
  }

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
    if (chartRange !== '5m' && Date.now() - historyFetchedAt >= HISTORY_REFRESH_MS) fetchHistory();
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

// The server records temperatures even while no page is open or this tab is hidden,
// so its readings fill in the charts on load and when the tab comes back
const fetchHistory = async () => {
  historyFetchedAt = Date.now();
  try {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    const { recent, minutes } = await response.json();

    // Keep any live readings newer than the server's newest one
    const newestServerTime = recent.at(-1)?.time ?? 0;
    const newerLive = tempHistory.filter((sample) => sample.time > newestServerTime);
    tempHistory.splice(0, tempHistory.length, ...recent, ...newerLive);
    minuteHistory = minutes;
    latestTime = Math.max(latestTime, newestServerTime);
    renderChart();
  } catch (err) {
    console.error(err);
  }
};

const setChartRange = (range) => {
  chartRange = range;
  const { label } = CHART_RANGES[range];
  rangeLabel.textContent = label;
  sparkline.setAttribute('aria-label', `CPU temperature over the ${label.toLowerCase()}`);
  if (range !== '5m' && Date.now() - historyFetchedAt >= HISTORY_REFRESH_MS) fetchHistory();
  renderChart();
};

const handleRangeChange = (event) => {
  handleChartLeave(); // the tooltip belonged to the old range
  setChartRange(event.target.value);
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

const handleChartHover = (event) => {
  const samples = getChartSamples();
  if (samples.length === 0) return;
  const { points } = getChartPoints(samples);
  const bounds = sparkline.getBoundingClientRect();
  const mouseX = event.clientX - bounds.left;

  const nearest = points.reduce((best, point) =>
    Math.abs(point.x - mouseX) < Math.abs(best.x - mouseX) ? point : best
  );

  crosshair.setAttribute('x1', nearest.x);
  crosshair.setAttribute('x2', nearest.x);
  hoverDot.setAttribute('cx', nearest.x);
  hoverDot.setAttribute('cy', nearest.y);
  sparkline.classList.add('isHovering');

  // The 5-minute chart says how long ago; the longer ones show the clock time of each minute's average
  if (chartRange === '5m') {
    const age = latestTime - nearest.time;
    chartTooltip.textContent = `${nearest.tempC.toFixed(1)} °C · ${age === 0 ? 'now' : formatAgo(age)}`;
  } else {
    const clockTime = new Date(nearest.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    chartTooltip.textContent = `${nearest.tempC.toFixed(1)} °C average · ${clockTime}`;
  }
  chartTooltip.style.left = `${Math.min(Math.max(nearest.x, 60), bounds.width - 60)}px`;
  chartTooltip.hidden = false;
};

const handleChartLeave = () => {
  sparkline.classList.remove('isHovering');
  chartTooltip.hidden = true;
};

/**************************************************************
Event listeners
***************************************************************/
sparkline.addEventListener('pointermove', handleChartHover);
sparkline.addEventListener('pointerleave', handleChartLeave);
window.addEventListener('resize', renderChart);
document.addEventListener('visibilitychange', handleVisibilityChange);
rangeInputs.forEach((input) => input.addEventListener('change', handleRangeChange));

fetchHistory();
// Some browsers restore the last picked range on reload, so start from whichever is checked
setChartRange(document.querySelector('input[name="chartRange"]:checked').value);
pollVitals();
