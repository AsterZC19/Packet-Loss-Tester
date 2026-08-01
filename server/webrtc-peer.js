// server/webrtc-peer.js
// The measurement core. Runs one WebRTC "echo" peer per browser session:
//
//   - accepts the browser's offer (browser is the offerer),
//   - routes the two data channels by label:
//       'control'  -> reliable JSON control (ready/start/live/stop/summary)
//       'test'     -> unreliable binary frames; server counts arrivals and
//                     echoes them back so the client can compute real loss.
//
// Frame formats (big-endian binary on the 'test' channel):
//   DATA (browser->server): [0x01][seq u32][sendAt f64][padding to cfg.size]
//   ECHO (server->browser): [0x02][seq u32][sendAt f64][srvRecvIdx u32]
//                           [srvEchoIdx u32][padding to same size]
//
// sendAt is a client-clock timestamp the server treats as an opaque token and
// echoes verbatim — no clock synchronization exists anywhere, so RTT is the
// only timing the client trusts.
import nodeDataChannel from 'node-datachannel';
import { config } from './config.js';

const { PeerConnection } = nodeDataChannel;

const ECHO_QUEUE_MAX = 256 * 1024; // server-side echo backpressure cap
const SETTLE_QUIET_MS = 200;       // quiet period with no new DATA = in-flight drained
const SETTLE_MAX_MS = 1000;        // hard cap on settle wait
const LIVE_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class EchoPeer {
  /**
   * @param {object} opts
   * @param {(json: object) => void} opts.send   send a JSON envelope over the WebSocket
   */
  constructor(opts) {
    this.send = opts.send;
    this.pc = null;
    this.ctrl = null; // reliable control channel
    this.test = null; // unreliable test channel

    // measurement counters (reset per test)
    this.srvRecvCount = 0;
    this.srvEchoCount = 0;
    this.srvEchoBuilt = 0; // unique per-built index, independent of sends
    this.srvRecvBytes = 0;
    this.serverDropEchoCount = 0;

    this.testing = false;
    this.stopping = false;
    this.testId = 0;
    this.currentSize = 0;
    this.lastDataAt = 0;
    this.liveTimer = null;
    this.settlePromise = null;
    this.pendingEchoTimers = new Set();
    this.timerLag = 0; // rolling estimate of how late JS timers fire (ms)

    this._createPeerConnection();
  }

  // JS timers fire late on this server because node-datachannel's native SCTP
  // processing occupies the event-loop poll phase in ~15ms chunks. That late
  // fire time is what a client would actually observe, but it makes the
  // *simulated* latency overshoot. This helper measures the lag and compensates
  // so a requested delay (e.g. 50ms) fires as close to 50ms as possible.
  _calibratedTimeout(fn, delayMs) {
    const start = performance.now();
    const compDelay = Math.max(1, delayMs - this.timerLag);
    const handle = setTimeout(() => {
      const actualLag = performance.now() - start - compDelay;
      this.timerLag = this.timerLag * 0.7 + actualLag * 0.3;
      fn();
    }, compDelay);
    return handle;
  }

  _createPeerConnection() {
    const rtc = {
      iceServers: config.serverIce.iceServers,
    };
    if (config.serverIce.bindAddress) rtc.bindAddress = config.serverIce.bindAddress;
    if (config.serverIce.portRange) {
      rtc.portRangeBegin = config.serverIce.portRange[0];
      rtc.portRangeEnd = config.serverIce.portRange[1];
    }
    if (config.serverIce.enableIceUdpMux) rtc.enableIceUdpMux = true;

    this.pc = new PeerConnection('browser', rtc);

    this.pc.onLocalDescription((sdp) => {
      // sdp is the answer (we are the answerer)
      this._dbg(`local description (${sdp.length} chars) -> answer`);
      this.send({ t: 'answer', sdp });
    });
    this.pc.onLocalCandidate((candidate, mid) => {
      this._dbg(`local candidate mid=${mid}`);
      this.send({ t: 'ice', candidate, mid });
    });
    this.pc.onGatheringStateChange((state) => {
      this._dbg('gathering state:', state);
      if (state === 'complete') this.send({ t: 'ice', candidate: null, mid: null });
    });
    this.pc.onStateChange((state) => {
      // ICE connection state: new / checking / connected / completed / failed / disconnected / closed
      this._dbg('ICE state:', state);
      if (state === 'failed' || state === 'closed') {
        this.send({ t: 'peerState', state });
      }
    });
    this.pc.onDataChannel((dc) => {
      const label = dc.getLabel();
      this._dbg('data channel:', label);
      if (label === 'control') this._bindControl(dc);
      else if (label === 'test') this._bindTest(dc);
      else dc.close();
    });
  }

  // ---- signaling -----------------------------------------------------------

  _dbg(...args) {
    if (process.env.PL_DEBUG) console.log('[peer]', ...args);
  }

  setRemoteOffer(sdp) {
    this._dbg('setRemoteDescription(offer) — answer auto-generates');
    try {
      // The answer is generated automatically by the library and surfaced via
      // the onLocalDescription callback registered in _createPeerConnection.
      // (Registering callbacks before setRemoteDescription is required.)
      this.pc.setRemoteDescription(sdp, 'Offer');
    } catch (err) {
      this.send({ t: 'error', message: `failed to accept offer: ${err.message}` });
    }
  }

  addIce(candidate, mid) {
    if (candidate && mid) {
      this._dbg('addRemoteCandidate', String(candidate).slice(0, 40), '...');
      try {
        this.pc.addRemoteCandidate(candidate, mid);
      } catch (err) {
        this.send({ t: 'error', message: `failed to add remote candidate: ${err.message}` });
      }
    }
  }

  // ---- control channel -----------------------------------------------------

  _bindControl(dc) {
    this.ctrl = dc;
    dc.onOpen(() => {
      this._sendControl({ t: 'ready' });
    });
    dc.onMessage((msg) => {
      let json;
      try {
        json = JSON.parse(msg.toString());
      } catch {
        return;
      }
      this._onControl(json);
    });
    dc.onClosed(() => this.destroy());
  }

  _sendControl(json) {
    if (this.ctrl && this.ctrl.isOpen()) {
      this.ctrl.sendMessage(JSON.stringify(json));
    }
  }

  _onControl(msg) {
    switch (msg.t) {
      case 'start': {
        const cfg = msg.cfg ?? {};
        this.testing = true;
        this.stopping = false;
        this.testId = (this.testId + 1) | 0;
        this.currentSize = Math.max(40, cfg.size ?? 0);
        this.srvRecvCount = 0;
        this.srvEchoCount = 0;
        this.srvEchoBuilt = 0;
        this.srvRecvBytes = 0;
        this.serverDropEchoCount = 0;
        this.lastDataAt = 0;
        this._startLive();
        this._sendControl({ t: 'started', testId: this.testId });
        break;
      }
      case 'stop': {
        this._onStop();
        break;
      }
    }
  }

  _startLive() {
    clearInterval(this.liveTimer);
    this.liveTimer = setInterval(() => {
      this._sendControl({ t: 'live', srvRecvCount: this.srvRecvCount, srvEchoCount: this.srvEchoCount });
    }, LIVE_INTERVAL_MS);
  }

  async _onStop() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.liveTimer);

    // Settle: keep echoing anything still in flight, wait for the echo queue to
    // drain plus a quiet period, then report the authoritative counters on the
    // reliable control channel (so the loss of the *final echo* cannot cost us
    // the numbers). Hard-capped so a silent client can't hang the session.
    const started = Date.now();
    while (true) {
      const quiet = this.lastDataAt === 0 || Date.now() - this.lastDataAt >= SETTLE_QUIET_MS;
      const drained = !this.test || this.test.bufferedAmount() === 0;
      const noPending = this.pendingEchoTimers.size === 0;
      const timedOut = Date.now() - started >= SETTLE_MAX_MS;
      if ((quiet && drained && noPending) || timedOut) break;
      await sleep(20);
    }

    this.testing = false;
    this._sendSummary();
  }

  _sendSummary() {
    const summary = {
      t: 'summary',
      testId: this.testId,
      srvRecvCount: this.srvRecvCount,
      srvEchoCount: this.srvEchoCount,
      serverDropEchoCount: this.serverDropEchoCount,
      srvRecvBytes: this.srvRecvBytes,
    };
    this._sendControl(summary);
    this.send(summary); // mirror to WebSocket as a fallback
  }

  // ---- test channel --------------------------------------------------------

  _bindTest(dc) {
    this.test = dc;
    dc.onMessage((msg) => this._onTestData(msg));
    dc.onClosed(() => this.destroy());
  }

  _onTestData(msg) {
    this.lastDataAt = Date.now();
    if (!this.testing) return; // ignore stray frames outside a test window

    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);

    // Simulated upload loss: the frame is dropped on the wire, so the server
    // never receives it — it must not count toward srvRecvCount.
    const sim = config.simulate;
    if (sim.enabled && sim.uploadLoss > 0 && this._drop(sim.uploadLoss)) return;

    this.srvRecvCount++;
    this.srvRecvBytes += buf.length;

    // Build an ECHO frame at the same size (symmetric downlink load).
    // srvEchoIdx is assigned at BUILD time (unique per built echo); the actual
    // send happens later (simulated latency) or not at all (download loss), so
    // it must not depend on srvEchoCount which only counts *sent* echoes.
    const size = this.currentSize || buf.length;
    const echo = Buffer.alloc(size);
    buf.copy(echo, 0, 0, Math.min(buf.length, 21));
    echo[0] = 0x02;
    echo.writeUInt32BE(this.srvRecvCount, 13);
    echo.writeUInt32BE(++this.srvEchoBuilt, 17);

    this._dispatchEcho(echo);
  }

  _dispatchEcho(echo) {
    const sim = config.simulate;
    if (sim.enabled) {
      if (sim.downloadLoss > 0 && this._drop(sim.downloadLoss)) {
        // Simulated download loss: the echo leaves the server but is lost on
        // the wire, so it still counts toward srvEchoCount (the denominator
        // the client uses for download loss).
        this.srvEchoCount++;
        return;
      }
      const delay =
        sim.latencyMs > 0
          ? sim.latencyMs + (sim.jitterMs > 0 ? (Math.random() * 2 - 1) * sim.jitterMs : 0)
          : 0;
      if (delay > 0) {
        const handle = this._calibratedTimeout(() => {
          this.pendingEchoTimers.delete(handle);
          this._pushEcho(echo);
        }, delay);
        this.pendingEchoTimers.add(handle);
        return;
      }
    }
    this._pushEcho(echo);
  }

  _pushEcho(echo) {
    if (!this.test || !this.test.isOpen()) return;
    if (this.test.bufferedAmount() > ECHO_QUEUE_MAX) {
      // Server-side backpressure: don't let the echo queue balloon. The client
      // still gets the authoritative count in the summary, so download loss is
      // unaffected — this only guards memory.
      this.serverDropEchoCount++;
      return;
    }
    const sent = this.test.sendMessageBinary(echo);
    if (sent) this.srvEchoCount++;
    else this.serverDropEchoCount++;  }

  _drop(pct) {
    return Math.random() * 100 < pct;
  }

  // ---- teardown ------------------------------------------------------------

  destroy() {
    clearInterval(this.liveTimer);
    for (const h of this.pendingEchoTimers) clearTimeout(h);
    this.pendingEchoTimers.clear();
    try {
      if (this.pc) this.pc.close();
    } catch {
      /* already closed */
    }
    this.pc = null;
    this.ctrl = null;
    this.test = null;
  }
}
