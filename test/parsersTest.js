// Checks how the dashboard reads the Pi's /proc and /sys files and command output, using sample
// text, including the awkward cases: program names with spaces, several throttling flags at once,
// a missing Wi-Fi link, counters that run into the colon.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsers } = require('../controller/vitalsController');

describe('parseMeminfo', () => {
  it('counts used memory as total minus available, like `free`', () => {
    const meminfo = ['MemTotal:        8251392 kB', 'MemFree:          912345 kB', 'MemAvailable:    4128768 kB', ''].join('\n');
    assert.deepEqual(parsers.parseMeminfo(meminfo), { totalMb: 8058, usedMb: 4026 });
  });
});

describe('parseThrottled', () => {
  it('reports nothing when all is well', () => {
    assert.deepEqual(parsers.parseThrottled('throttled=0x0\n'), { now: [], sinceBoot: [] });
  });

  it('tells "since boot" (bits 16+) apart from "right now"', () => {
    assert.deepEqual(parsers.parseThrottled('throttled=0x50000\n'), {
      now: [],
      sinceBoot: ['Under-voltage', 'Throttled'],
    });
  });

  it('lists every flag that is set', () => {
    assert.deepEqual(parsers.parseThrottled('throttled=0xe000e\n'), {
      now: ['Clock capped', 'Throttled', 'Soft temperature limit'],
      sinceBoot: ['Clock capped', 'Throttled', 'Soft temperature limit'],
    });
  });
});

describe('parseNetwork', () => {
  const wireless = [
    'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE',
    ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22',
    ' wlan0: 0000   63.  -47.  -256        0      0      0      0      0        0',
  ].join('\n');
  const dev = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0',
    ' wlan0: 123456789  1000    0    0    0     0          0         0 98765432    2000    0    0    0     0       0          0',
  ].join('\n');

  it('reads the signal and the byte counters', () => {
    assert.deepEqual(parsers.parseNetwork(wireless, dev), {
      linkPercent: 90, // 63 out of 70
      signalDbm: -47,
      rxBytes: 123456789,
      txBytes: 98765432,
    });
  });

  it('copes with a counter big enough to touch the colon', () => {
    const bigDev = dev.replace(' wlan0: 123456789', ' wlan0:12345678901');
    assert.equal(parsers.parseNetwork(wireless, bigDev).rxBytes, 12345678901);
  });

  it('has no signal when the interface has no Wi-Fi link', () => {
    const noLink = wireless.split('\n').slice(0, 2).join('\n');
    const result = parsers.parseNetwork(noLink, dev);
    assert.equal(result.signalDbm, null);
    assert.equal(result.linkPercent, null);
    assert.equal(result.rxBytes, 123456789);
  });

  it('returns null when the interface does not exist', () => {
    assert.equal(parsers.parseNetwork(wireless, dev, 'wlan1'), null);
  });
});

describe('parseProcessStat', () => {
  // Fields after the name: state, ppid, pgrp, session, tty, tpgid, flags, 4 fault counts,
  // utime 250, stime 50, cutime, cstime, priority, nice, threads, itrealvalue, starttime, vsize, rss 4096
  const statFields = 'S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 1000 123456789 4096 18446744073709551615';

  it('keeps a name with spaces whole', () => {
    assert.deepEqual(parsers.parseProcessStat(1234, `1234 (Isolated Web Co) ${statFields}`), {
      pid: 1234,
      name: 'Isolated Web Co',
      ticks: 300,
      residentPages: 4096,
    });
  });

  it('keeps a name that itself contains ")"', () => {
    assert.equal(parsers.parseProcessStat(99, `99 (odd) name) ${statFields}`).name, 'odd) name');
  });
});

describe('groupProcesses', () => {
  const constants = { pageSize: 16384, clockTicks: 100 };

  it('groups by name, works out CPU from the ticks since the last poll, and puts the busiest first', () => {
    const processes = [
      { pid: 1, name: 'chromium', ticks: 1000, residentPages: 1000 },
      { pid: 2, name: 'chromium', ticks: 500, residentPages: 500 },
      { pid: 3, name: 'node', ticks: 2000, residentPages: 2000 },
      { pid: 4, name: 'brand-new', ticks: 999, residentPages: 10 },
    ];
    const previousTicks = new Map([[1, 900], [2, 450], [3, 1990]]); // pid 4 started since the last poll

    assert.deepEqual(parsers.groupProcesses(processes, previousTicks, 2, constants), [
      { name: 'chromium', cpuPercent: 75, memoryMb: 23, count: 2 }, // (100 + 50) ticks / 100 per s / 2 s
      { name: 'node', cpuPercent: 5, memoryMb: 31, count: 1 },
      { name: 'brand-new', cpuPercent: 0, memoryMb: 0, count: 1 }, // nothing counted for a new process yet
    ]);
  });

  it('breaks CPU ties by memory and keeps only the top 5', () => {
    const processes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, index) => ({
      pid: index + 1,
      name,
      ticks: 0,
      residentPages: (index + 1) * 64, // g uses the most memory
    }));
    const names = parsers.groupProcesses(processes, new Map(), 2, constants).map((group) => group.name);
    assert.deepEqual(names, ['g', 'f', 'e', 'd', 'c']);
  });
});

describe('parseDriveKind', () => {
  it('names the drive mounted at /', () => {
    const mounts = '/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n/dev/mmcblk0p1 /boot/firmware vfat rw 0 0\n';
    assert.equal(parsers.parseDriveKind(mounts), 'SD card');
    assert.equal(parsers.parseDriveKind('/dev/nvme0n1p2 / ext4 rw 0 0\n'), 'NVMe drive');
    assert.equal(parsers.parseDriveKind('/dev/sda2 / ext4 rw 0 0\n'), 'USB drive');
  });

  it('uses the last line for / when there are two', () => {
    assert.equal(parsers.parseDriveKind('rootfs / rootfs rw 0 0\n/dev/nvme0n1p2 / ext4 rw 0 0\n'), 'NVMe drive');
  });

  it('falls back to the device name, or null when / is missing', () => {
    assert.equal(parsers.parseDriveKind('overlay / overlay rw 0 0\n'), 'overlay');
    assert.equal(parsers.parseDriveKind('tmpfs /tmp tmpfs rw 0 0\n'), null);
  });
});

describe('getDiskUsage', () => {
  it('matches `df` (a reading from this Pi, taken while `df` said 52%)', () => {
    const stats = { blocks: 7469238, bfree: 3806432, bavail: 3476240, bsize: 4096 };
    assert.deepEqual(parsers.getDiskUsage(stats), {
      totalBytes: 30593998848,
      usedBytes: 15002853376,
      freeBytes: 14238679040,
      usedPercent: 52, // 51.3% rounded up, as df does
    });
  });
});
