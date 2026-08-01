// test/browser.mjs — real-browser E2E: drives the web UI in installed Edge.
//   usage: node test/browser.mjs  (server must already be running on :8787)
import { chromium } from 'playwright-core';

const EDGE =
  process.env.EDGE_PATH ??
  (process.platform === 'win32' && process.arch === 'x64'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');

const DURATION_S = parseInt(process.argv[2] ?? '5', 10);

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  // Google STUN can't reflect a usable localhost/LAN address, so local browser
  // testing relies on real host candidates — disable Chrome/Edge mDNS
  // obfuscation so node-datachannel can resolve them.
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('[console] ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await page.goto('http://localhost:8787', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#server option').length >= 2, {
    timeout: 10000,
    polling: 200,
  });
  await page.selectOption('#duration', String(DURATION_S));
  await page.click('#start-btn');
  console.log('started, waiting for result panel...');

  await page.waitForSelector('#result-panel:not([hidden])', { timeout: 60000 });

  const readResults = () =>
    page.evaluate(() => {
      const $ = (id) => document.getElementById(id)?.textContent?.trim();
      return {
        grade: $('grade-letter'),
        upLoss: $('up-loss'),
        downLoss: $('down-loss'),
        rttAvg: $('rtt-avg'),
        jitter: $('jitter-avg'),
        status: $('status'),
        chartDrawn: (() => {
          const c = document.getElementById('chart-result');
          return c && c.width > 0 && c.height > 0;
        })(),
      };
    });

  const run1 = await readResults();
  console.log('RUN 1:', JSON.stringify(run1));

  // Re-run: click the "重新测试" button and expect a second result on the same connection.
  await page.click('#start-btn');
  await page.waitForSelector('#result-panel:not([hidden])', { timeout: 60000 });
  const run2 = await readResults();
  console.log('RUN 2:', JSON.stringify(run2));

  console.log('console/page errors:', errors.length ? '\n' + errors.join('\n') : 'none');
  if (errors.length) process.exitCode = 1;
  if (!run1.rttAvg || run1.rttAvg === '--') process.exitCode = 1;
  if (!run2.rttAvg || run2.rttAvg === '--') process.exitCode = 1;
} finally {
  await browser.close();
}
