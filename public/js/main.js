/**************************************************************
DOM selectors
***************************************************************/
const root = document.documentElement;
const liveStatus = document.querySelector('.liveStatus');
const liveText = document.querySelector('.liveText');

const tempValue = document.querySelector('.tempValue');
const tempPill = document.querySelector('.tempSection .statusPill');
const tempRange = document.querySelector('.tempRange');
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
const HISTORY_MS = 5 * 60 * 1000; // the chart shows the last 5 minutes
// Readings further apart than this get a gap in the line instead of a straight join,
// for example after the server couldn't be reached for a while
const GAP_MS = POLL_MS * 3;
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

const tempHistory = [];
let lastSpinRpm = 0;
let lastNetwork = null; // previous byte counters, for working out speeds

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
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
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

// Map history to pixel positions for the current chart width
const getChartPoints = () => {
  const width = sparkline.clientWidth;
  const temps = tempHistory.map((sample) => sample.tempC);
  const { low, high } = getYRange(temps);
  const plotWidth = width - CHART_PAD.left - CHART_PAD.right;
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;

  // Readings sit by time: the newest on the right edge, 5 minutes before it on the left edge
  const newestTime = tempHistory[tempHistory.length - 1].time;

  const points = tempHistory.map((sample) => ({
    ...sample,
    x: CHART_PAD.left + plotWidth * (1 - (newestTime - sample.time) / HISTORY_MS),
    y: CHART_PAD.top + plotHeight * (1 - (sample.tempC - low) / (high - low)),
  }));

  return { width, low, high, plotHeight, points };
};

/**************************************************************
Render functions
***************************************************************/
const renderChart = () => {
  if (tempHistory.length === 0) return;
  const { width, low, high, plotHeight, points } = getChartPoints();
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
      const startsPiece = index === 0 || point.time - points[index - 1].time > GAP_MS;
      return `${startsPiece ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(' ');
  sparkLine.setAttribute('d', pathData);

  // Mark the newest reading, so the very first one is visible before there's a line
  const latest = points[points.length - 1];
  latestDot.setAttribute('cx', latest.x);
  latestDot.setAttribute('cy', latest.y);

  const temps = tempHistory.map((sample) => sample.tempC);
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

    tempHistory.push({ time: vitals.time, tempC: vitals.cpuTempC });
    // Keep only the readings the chart shows
    while (tempHistory[0].time < vitals.time - HISTORY_MS) tempHistory.shift();
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
const pollVitals = async () => {
  try {
    const response = await fetch('/api/vitals');
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    const vitals = await response.json();

    renderVitals(vitals);
    liveStatus.classList.add('isLive');
    liveStatus.classList.remove('isOffline');
    liveText.textContent = `Live · ${new Date(vitals.time).toLocaleTimeString()}`;
  } catch (err) {
    console.error(err);
    liveStatus.classList.remove('isLive');
    liveStatus.classList.add('isOffline');
    liveText.textContent = 'Lost connection, retrying…';
  } finally {
    // Schedule the next poll only after this one finishes, so requests never pile up
    setTimeout(pollVitals, POLL_MS);
  }
};

const handleChartHover = (event) => {
  if (tempHistory.length === 0) return;
  const { points } = getChartPoints();
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

  const latestTime = tempHistory[tempHistory.length - 1].time;
  const age = latestTime - nearest.time;
  chartTooltip.textContent = `${nearest.tempC.toFixed(1)} °C · ${age === 0 ? 'now' : formatAgo(age)}`;
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

pollVitals();
