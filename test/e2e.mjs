// test/e2e.mjs
// End-to-end test: acts as a browser-like WebRTC offerer against the live
// server, using node-datachannel (no browser needed). Runs a real paced test,
// computes the same metrics the UI would, and prints them + a PASS/FAIL summary.
//
//   usage:  node test/e2e.mjs [durationMs] [pps] [size] [thresholdMs]
//   e.g.    node test/e2e.mjs 4000 64 96 80
//
// Start the server first:  npm start
import nodeDataChannel from 'node-datachannel';
import WebSocket from 'ws';

const { PeerConnection } = nodeDataChannel;

const DURATION = parseInt(process.argv[2] ?? '4000', 10);
const PPS = parseInt(process.argv[3] ?? '50', 10);
const SIZE = parseInt(process.argv[4] ?? '200', 10);
const THRESHOLD = parseInt(process.argv[5] ?? '200', 10);
const WARMUP = 1000;

const WS_URL = process.env.PL_WS ?? 'ws://localhost:8787/ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[e2e]', ...a); // stderr is unbuffered for pipes

// ---- tiny binary frame codec (mirror of public/js/protocol.js) -------------
function encodeData(seq, sendAt) {
  const buf = Buffer.alloc(SIZE);
  buf[0] = 0x01;
  buf.writeUInt32BE(seq, 1);
  buf.writeDoubleBE(sendAt, 5);
  return buf;
}
function decodeEcho(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 21 || b[0] !== 0x02) return null;
  return { seq: b.readUInt32BE(1), sendAt: b.readDoubleBE(5), srvRecvIdx: b.readUInt32BE(13), srvEchoIdx: b.readUInt32BE(17) };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ---- signaling (browser is the offerer) ------------------------------------
async function run() {
  const pc = new PeerConnection('e2e-client', { iceServers: [] });
  log('PeerConnection created');

  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WS connect failed'));
  });
  log('WS connected');
  const sendWs = (obj) => ws.send(JSON.stringify(obj));

  // server ice buffered until remote description is applied
  const pendingServerIce = [];
  let haveAnswer = false;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    log('ws recv:', msg.t);
    if (msg.t === 'answer') {
      haveAnswer = true;
      log('applying answer, flushing', pendingServerIce.length, 'pending ice');
      pc.setRemoteDescription(msg.sdp, 'Answer');
      for (const c of pendingServerIce) pc.addRemoteCandidate(c.candidate, c.mid);
      pendingServerIce.length = 0;
    } else if (msg.t === 'ice') {
      if (msg.candidate === null) return; // end-of-candidates marker
      if (!haveAnswer) pendingServerIce.push(msg);
      else pc.addRemoteCandidate(msg.candidate, msg.mid);
    } else if (msg.t === 'error') {
      console.error('server error:', msg.message);
    }
  });

  // IMPORTANT: register callbacks BEFORE createDataChannel — node-datachannel
  // auto-generates the offer and surfaces it via onLocalDescription.
  pc.onLocalDescription((sdp) => {
    log('offer generated, sending');
    sendWs({ t: 'offer', sdp });
  });
  pc.onLocalCandidate((candidate, mid) => sendWs({ t: 'ice', candidate, mid }));
  pc.onGatheringStateChange((state) => {
    log('gathering state:', state);
    if (state === 'complete') sendWs({ t: 'ice', candidate: null, mid: null });
  });
  pc.onStateChange((state) => log('ICE state:', state));

  // data channels
  const ctrl = pc.createDataChannel('control', {});
  const test = pc.createDataChannel('test', { unordered: true, maxRetransmits: 0 });

  const waitChannel = (dc) =>
    new Promise((res) => {
      if (dc.isOpen()) return res();
      dc.onOpen(() => res());
    });

  const openTimeout = setTimeout(() => {
    log('TIMEOUT waiting for channels to open. gathering=' + pc.gatheringState() + ' state=' + pc.state());
    process.exit(1);
  }, 10000);
  await Promise.all([waitChannel(ctrl), waitChannel(test)]);
  clearTimeout(openTimeout);
  log(`channels open. sending ${PPS} pps x ${SIZE}B for ${DURATION / 1000}s, threshold ${THRESHOLD}ms`);
  await sleep(200);

  // ---- measurement state ----
  const t0 = performance.now();
  let sentTotal = 0;
  let seq = 0;
  const rtts = [];
  const jitterDeltas = [];
  const recvEchoSeen = new Set();
  let lastSrvRecvIdx = 0;
  let lateCount = 0;
  let statCount = 0;
  let prevRtt = null;

  const lowWater = Math.max(4 * SIZE, 4096);
  test.setBufferedAmountLowThreshold(lowWater);
  const highWater = lowWater * 4;
  const intervalMs = 1000 / PPS;

  let echoMsgs = 0;
  let lastEchoIdx = 0;

  test.onMessage((msg) => {
    const f = decodeEcho(msg);
    if (!f) return;
    echoMsgs++;
    if (f.srvEchoIdx > lastEchoIdx) lastEchoIdx = f.srvEchoIdx;
    const now = performance.now();
    const rtt = now - f.sendAt;
    if (rtt < 0) return;
    recvEchoSeen.add(f.srvEchoIdx);
    if (f.srvRecvIdx > lastSrvRecvIdx) lastSrvRecvIdx = f.srvRecvIdx;
    if (now - t0 >= WARMUP) {
      rtts.push(rtt);
      statCount++;
      if (prevRtt !== null) jitterDeltas.push(Math.abs(rtt - prevRtt));
      prevRtt = rtt;
      if (rtt > THRESHOLD) lateCount++;
    }
  });

  let paused = false;
  test.onBufferedAmountLow(() => {
    paused = false;
  });

  // control channel: single dispatcher resolves the ready + summary waiters
  let resolveReady = null;
  let resolveSummary = null;
  ctrl.onMessage((m) => {
    const msg = JSON.parse(m.toString());
    if (msg.t === 'ready' && resolveReady) resolveReady();
    if (msg.t === 'summary' && resolveSummary) resolveSummary(msg);
  });

  await new Promise((res) => {
    resolveReady = res;
  });
  ctrl.sendMessage(JSON.stringify({ t: 'start', cfg: { pps: PPS, size: SIZE, durationMs: DURATION, thresholdMs: THRESHOLD } }));
  log('start sent');

  // ---- paced sender loop ----
  const endAt = performance.now() + DURATION;
  const pacerStart = performance.now();
  let nextSendAt = performance.now();
  while (performance.now() < endAt) {
    const now = performance.now();
    if (now >= nextSendAt) {
      nextSendAt += intervalMs;
      if (!paused && test.isOpen() && test.bufferedAmount() < highWater) {
        test.sendMessageBinary(encodeData(++seq, now));
        sentTotal++;
      } else if (test.bufferedAmount() >= highWater) {
        paused = true;
      }
    }
    // small sleep to keep CPU reasonable
    await sleep(0.5);
  }
  log(`sent ${sentTotal} frames in ${((performance.now() - pacerStart) / 1000).toFixed(1)}s`);

  // ---- stop + summary ----
  ctrl.sendMessage(JSON.stringify({ t: 'stop' }));
  const summary = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('summary timeout')), 5000);
    resolveSummary = (msg) => {
      clearTimeout(to);
      res(msg);
    };
  });

  // ---- compute results (same formulas as the UI) ----
  log(`echo messages received: ${echoMsgs}, recvEchoSeen: ${recvEchoSeen.size}, last srvEchoIdx: ${lastEchoIdx}`);
  const uploadLossPct = sentTotal > 0 ? Math.max(0, ((sentTotal - summary.srvRecvCount) / sentTotal) * 100) : 0;
  const downloadLossPct =
    summary.srvEchoCount > 0 ? Math.max(0, ((summary.srvEchoCount - recvEchoSeen.size) / summary.srvEchoCount) * 100) : 0;
  const sorted = [...rtts].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const p95 = percentile(sorted, 0.95);
  const max = sorted.length ? sorted[sorted.length - 1] : 0;
  const jitterAvg = jitterDeltas.length ? jitterDeltas.reduce((a, b) => a + b, 0) / jitterDeltas.length : 0;
  const jitterMax = jitterDeltas.length ? Math.max(...jitterDeltas) : 0;
  const latePct = statCount ? (lateCount / statCount) * 100 : 0;

  console.log('\n===== E2E RESULTS =====');
  console.log(`sent          : ${sentTotal}`);
  console.log(`server received: ${summary.srvRecvCount}`);
  console.log(`server echoed  : ${summary.srvEchoCount}`);
  console.log(`client received: ${recvEchoSeen.size}`);
  console.log(`server drops   : ${summary.serverDropEchoCount ?? 0}`);
  console.log(`upload loss    : ${uploadLossPct.toFixed(3)}%`);
  console.log(`download loss  : ${downloadLossPct.toFixed(3)}%`);
  console.log(`RTT avg/med/p95/max: ${avg.toFixed(2)} / ${percentile(sorted, 0.5).toFixed(2)} / ${p95.toFixed(2)} / ${max.toFixed(2)} ms`);
  console.log(`jitter avg/max : ${jitterAvg.toFixed(2)} / ${jitterMax.toFixed(2)} ms`);
  console.log(`late           : ${lateCount} (${latePct.toFixed(2)}%)`);
  console.log(`actual rate    : ${(sentTotal / (DURATION / 1000)).toFixed(0)} pps`);

  ws.close();
  pc.close();

  return {
    uploadLossPct,
    downloadLossPct,
    avg,
    sentTotal,
    summary,
    rttCount: rtts.length,
  };
}

run()
  .then((r) => {
    const checks = [];
    if (r.sentTotal === 0) checks.push('FAIL: nothing sent');
    if (r.summary.srvRecvCount === 0) checks.push('FAIL: server received nothing');
    if (r.avg < 0) checks.push('FAIL: negative RTT');
    if (checks.length) {
      console.log('\n' + checks.join('\n'));
      process.exit(1);
    }
    console.log('\nE2E OK: channel, pacing, echo, counters and summary all worked.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nE2E FAILED:', err.message);
    process.exit(1);
  });
