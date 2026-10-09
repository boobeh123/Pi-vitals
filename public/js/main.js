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
const meter = document.querySelector('.meter');
const meterFill = document.querySelector('.meterFill');
const uptime = document.querySelector('.uptime');
const healthPill = document.querySelector('.healthPill');
const healthNote = document.querySelector('.healthNote');
const adguardPill = document.querySelector('.adguardPill');

/**************************************************************
Settings and state
***************************************************************/
const POLL_MS = 2000;
const HISTORY_LENGTH = 150; // 150 samples x 2s = 5 minutes
const CHART_HEIGHT = 140;
const CHART_PAD = { top: 8, right: 8, bottom: 8, left: 34 };
const SVG_NS = 'http://www.w3.org/2000/svg';

// The real fan spins ~2000+ RPM, which would just look like a blur.
// Show it at 1/40 speed so faster still clearly means faster.
const FAN_VISUAL_SCALE = 40;

const tempHistory = [];
let lastSpinRpm = 0;

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

  // Newest sample sits on the right edge; slots are fixed so the line scrolls left
  const step = plotWidth / (HISTORY_LENGTH - 1);
  const offset = HISTORY_LENGTH - tempHistory.length;

  const points = tempHistory.map((sample, index) => ({
    ...sample,
    x: CHART_PAD.left + (offset + index) * step,
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

  const pathData = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');
  sparkLine.setAttribute('d', pathData);

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

const renderVitals = (vitals) => {
  if (vitals.cpuTempC !== null) {
    tempValue.textContent = vitals.cpuTempC.toFixed(1);
    const { status, text } = getTempStatus(vitals.cpuTempC);
    setPill(tempPill, status, text);

    tempHistory.push({ time: vitals.time, tempC: vitals.cpuTempC });
    if (tempHistory.length > HISTORY_LENGTH) tempHistory.shift();
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
  meterFill.style.width = `${memPercent}%`;
  meter.setAttribute('aria-valuenow', memPercent);

  uptime.textContent = formatUptime(vitals.uptimeSec);
  renderHealth(vitals.throttling);

  const adguardRunning = vitals.adguard === 'active';
  setPill(adguardPill, adguardRunning ? 'good' : 'critical', adguardRunning ? 'Running' : `Not running (${vitals.adguard})`);
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
