# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pi Vitals is a live dashboard for the Raspberry Pi 5 it runs on: an Express 5 + EJS app that reads the Pi's own sensors from `/sys`, `/proc` and a few commands, and serves a page that polls `/api/vitals` every 2 seconds. No database, no outside services, nothing needs sudo. It can't be hosted anywhere else, because it reads the hardware of the machine it runs on.

## Commands

```bash
npm start      # http://127.0.0.1:3141 (PORT, HOST and HISTORY_FILE come from .env)
npm run dev    # same, restarting on file changes (node --watch)
npm test       # node --test test/parsersTest.js test/serverTest.js (~2 s)

node --test --test-name-pattern="history file" test/serverTest.js   # one suite or test by name
```

The tests use Node's built-in runner and read the Pi's real sensors, so run them on the Pi. `serverTest.js` spawns the real `server.js` on a free port with `HISTORY_FILE` in a temp folder, so it never touches `data/history.json` and can run while the service is up.

## The live service runs from this folder

A systemd **user** service (`deploy/pi-vitals.service`, installed in `~/.config/systemd/user/`, linger enabled) runs `node server.js` from `~/projects/pi-vitals` at boot, on 127.0.0.1:3141. It serves `public/` and `views/` straight from this folder (no view cache outside production), so **editing files here changes the live dashboard at once, but with the old server code** until a restart.

So develop in a git worktree in the scratchpad, run it on another port (`PORT=3142`), then fast-forward `main` here, push, and `systemctl --user restart pi-vitals`. Port 3141 is busy while the service runs. Logs: `journalctl --user -u pi-vitals`.

## Architecture

```
server.js                        helmet, morgan, static, routes, 404 + error handlers; calls startHistory()
routes/vitalsRoutes.js           GET /  ·  GET /api/vitals  ·  GET /api/history  (wiring only, no logic)
controller/vitalsController.js   reads every sensor in parallel for /api/vitals
controller/historyController.js  samples every 2 s whether or not a page is open; saves data/history.json
views/dashboard.ejs              all markup; every value starts as "--" and main.js fills it in
public/js/main.js                polling, rendering, the SVG chart (built by hand, no chart library)
public/css/styles.css            all styles; light and dark mode via custom properties
```

- **Parsers are pure.** In `vitalsController.js`, the Parsers block turns text (from `/proc`, `/sys` or a command) into plain data and reads nothing itself; the Helpers block does the reading. Parsers are exported as `exports.parsers` only for `test/parsersTest.js`, which feeds them sample text. A new sensor should follow the same split and get parser tests for its awkward cases.
- **Every reader returns `null` on failure**, never throws, and the page shows `n/a` or "Unavailable" for `null`. One missing sensor must never break `/api/vitals`.
- **Things that can't change while the Pi runs are read once** into a module-level promise (`driveKindPromise`, `systemConstantsPromise`, `lastRestartPromise`). Every `/api/vitals` response awaits these, so any command behind them needs a timeout. Anything slow or noisy is rate-limited the same way: the AdGuard DNS check shares one cached promise and runs at most once a minute.
- **Top programs** compare each process's CPU ticks between two polls (`lastProcessSample`), so the first `/api/vitals` response has `topProcesses: null`. The Pi 5 kernel uses 16 KB pages; page size and clock ticks come from `getconf`, never assumed.
- **Last restart** (`getPreviousBoot`): finds the boot before this one in `journalctl --list-boots -o json` (matched against `/proc/sys/kernel/random/boot_id`) and calls it clean if journald's "Journal stopped" message (`JOURNAL_STOPPED_ID`) is within 30 s of that boot's last entry. Restarting journald mid-boot also logs "Journal stopped", which is why only the end of the boot counts. Needs the persistent journal and the `adm` group. Also decodes the Pi 5's PMIC `power_reset` bits.
- **History** (`historyController.js`): every reading is `{ time, tempC, memPercent, swapPercent }` (`FIELDS`), any of which can be null. Minutes saved before Oct 14 2026 only have `tempC`; `loadHistory` fills in null. 2-second readings for the last 5 minutes (`recent`) plus one average per field per minute for 24 hours (`minutes`, stamped at the middle of the minute). Only `minutes` is saved, every 10 minutes and on SIGTERM/SIGINT, via a temp file and rename. A damaged file is logged and replaced with a fresh history. The timers are `unref()`ed. It reuses `parseMeminfo` from the vitals controller.
- **The browser's charts** are driven by the `CHARTS` array in `main.js`: each entry has its DOM `parts` (from `selectChart(section)`), its `series` keys (one `.sparkLine` path each, in order; the first gets the dots), its own `range`, and functions for the y axis, tick labels, tooltip text and caption summary. `renderChart(chart)`, `handleChartHover(chart, ...)` and `setChartRange(chart, ...)` work for any entry, so a new chart is a new section in the markup plus a `CHARTS` entry. Both charts share `recentHistory` (filled from polls, using the same fields as the server) and `minuteHistory`.
- **The browser** refetches `/api/history` on load, on tab return and once a minute while any chart shows a long range, and stops polling while the tab is hidden. Readings are placed on the chart by time, and readings further apart than a range's `gapMs` are drawn with a gap (null values are skipped per series, so a long run of them leaves a gap too).

## Rules

- **AdGuard Home is the whole house's DNS.** The dashboard only runs `systemctl is-active AdGuardHome` and looks up `example.com` at 127.0.0.1 once a minute. Never look up a blocked domain (it would add to the owner's block count), never read `/opt/AdGuardHome/AdGuardHome.yaml` (root-only), never call AdGuard's API (it needs the owner's admin login), and never stop the service to test the "Not running" state. To test failures, point a resolver at 192.0.2.1 (times out) or an unused localhost port (refused); 5353 is avahi and times out instead.
- **The server binds 127.0.0.1** unless `.env` sets `HOST`. Keep that default.
- **No new dependencies** without asking. The current five (express, ejs, helmet, dotenv, morgan) cover everything; the chart is hand-built SVG on purpose.
- **Helmet's CSP is on** and blocks inline scripts and inline event handlers. The standards also rule out inline styles in markup; setting `element.style` from JS for live values is fine (the meters, CPU bars and fan spin speed do it).
- **XSS**: the page fills values with `textContent` and `createElement`, never `innerHTML`; EJS output uses `<%= %>`.

## Conventions

The owner's coding standards (skill `boobeh123-code-standards`) apply. In this codebase that means:

- CommonJS, camelCase everywhere (files, variables, CSS classes, custom properties), verb-first function names, `async` controller functions with no `try/catch` just to call `next(err)` (Express 5 forwards rejected promises).
- Each JS file is split into blocks with this exact comment format, in this order. Client: DOM selectors, Settings and state, Helpers, Render functions, Main logic, Event listeners (always last). Server controllers use the blocks they need from: constants, Parsers, Helpers, Main logic, Handlers, For the tests.

  ```js
  /**************************************************************
  Helpers
  ***************************************************************/
  ```

- `querySelector`/`querySelectorAll` only. All selectors at the top of `main.js`.
- `styles.css`: Base (custom properties, then elements), Utilities, Components, sections in page order, Media queries last (including the reduced-motion rule). Colors and spacing come from custom properties, redefined for dark mode.
- Comments explain *why* in plain English; keep that density.
- Commit messages are plain English, imperative, under 72 characters, written for a non-developer ("Show whether AdGuard actually answers DNS, not just whether it runs").
- **The README documents every feature, the "Where the data comes from" table, the file map and what the tests cover.** Keep it in sync with code changes. The owner edits the README on GitHub too, so `git fetch` before touching it. `docs/piVitalsDemo.gif` is the README demo; mention it when a change makes it out of date.
