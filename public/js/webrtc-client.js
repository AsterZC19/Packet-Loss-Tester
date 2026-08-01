// public/js/webrtc-client.js
// Client-side measurement engine.
//
//  1. Opens a WebSocket to the signaling endpoint, negotiates an
//     RTCPeerConnection (browser is the offerer) with two data channels:
//       'control' -> reliable JSON control
//       'test'    -> unreliable (ordered:false, maxRetransmits:0) binary frames
//  2. Sends numbered frames at the configured rate while **pacing via
//     bufferedAmount** so packets actually hit the wire promptly — otherwise
//     local queueing would inflate measured RTT. This is what keeps the
//     latency numbers honest.
//  3. Server echoes each frame; RTT = now - sendAt (all on the client clock,
//     no clock sync anywhere). Loss comes from the server's authoritative
//     counters in the final summary.
//
// This module is pull-based for the chart (UI polls getTrendSeries() on each
// progress tick) and push-based for lifecycle events.
import { encodeDataFrame, decodeEchoFrame } from './protocol.js';

const WARMUP_MS = 1000; // skip first second of echoes in stats (SCTP cwnd ramp)
const BUCKET_MS = 200; // trend chart bucket width
const SETTLE_TIMEOUT_MS = 4000; // max wait for summary after stop

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export class WebrtcTestClient {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl      signaling WebSocket URL
   * @param {Array}  opts.iceServers RTCPeerConnection iceServers from /config
   * @param {(type: string, payload: object) => void} opts.onEvent
   */
  constructor({ wsUrl, iceServers, onEvent }) {
    this.wsUrl = wsUrl;
    this.iceServers = iceServers;
    this.onEvent = onEvent;

    this.ws = null;
    this.pc = null;
    this.ctrl = null;
    this.test = null;

    this.connected = false;
    this.negotiated = false;
    this.ctrlOpen = false;
    this.testOpen = false;
    this.haveAnswer = false;
    this.pendingServerIce = [];
    this._negotiationResolve = null;

    // measurement state
    this.running = false;
    this.cfg = null;
    this.seq = 0;
    this.sentTotal = 0;
    this.nextSendAt = 0;
    this.intervalMs = 0;
    this.timer = null;
    this.paused = false;
    this.highWater = 0;
    this.testStartAt = 0;
    this.warmupEndAt = 0;

    this.recvEchoSeen = new Set(); // srvEchoIdx values received (download-loss denominator)
    this.lastSrvRecvIdx = 0; // highest srvRecvIdx seen (live upload-loss)
    this.rtts = [];
    this.prevRtt = null;
    this.jitterDeltas = [];
    this.lateCount = 0;
    this.statEchoCount = 0;
    this.buckets = new Map(); // bucketIndex -> {n, sum, max, late}
    this.summary = null;
  }

  // ---- lifecycle -----------------------------------------------------------

  async connect() {
    if (this.connected) return;
    await this._connect();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      this._negotiationResolve = resolve;
      this._negotiationReject = reject;
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => this._negotiate();
      this.ws.onmessage = (e) => this._onWsMessage(e.data);
      this.ws.onerror = () => {
        if (this._negotiationReject) this._negotiationReject(new Error('WebSocket 连接失败'));
      };
      this.ws.onclose = () => {
        this.onEvent('wsclosed', {});
      };
    });
  }

  async start(cfg) {
    if (this.running) return;
    this.cfg = cfg;
    if (!this.connected) await this.connect();
    this._beginTest(cfg);
  }

  cancel() {
    this.running = false;
    clearTimeout(this.timer);
    try {
      if (this.pc) this.pc.close();
    } catch {}
    try {
      if (this.ws) this.ws.close();
    } catch {}
    this.pc = this.ws = this.ctrl = this.test = null;
    this.connected = this.negotiated = this.ctrlOpen = this.testOpen = this.haveAnswer = false;
    this.pendingServerIce = [];
    this.onEvent('cancelled', {});
  }

  destroy() {
    this.cancel();
  }

  // ---- negotiation ---------------------------------------------------------

  _negotiate() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._sendWs({ t: 'ice', candidate: e.candidate.candidate, mid: e.candidate.sdpMid });
      } else {
        this._sendWs({ t: 'ice', candidate: null, mid: null });
      }
    };
    pc.oniceconnectionstatechange = () => {
      this.onEvent('ice', { state: pc.iceConnectionState });
      if (pc.iceConnectionState === 'failed') {
        this.onEvent('error', { message: 'ICE 连接失败 — 检查防火墙 UDP 端口是否开放(STUN/ICE)。' });
      }
    };

    // reliable control channel
    this.ctrl = pc.createDataChannel('control', {});
    this.ctrl.onopen = () => {
      this.ctrlOpen = true;
      this._maybeReady();
    };
    this.ctrl.onmessage = (e) => this._onCtrlMessage(e.data);
    this.ctrl.onclose = () => this.onEvent('ctrlclosed', {});

    // unreliable test channel (UDP-like: no retransmit, unordered)
    this.test = pc.createDataChannel('test', { ordered: false, maxRetransmits: 0 });
    this.test.binaryType = 'arraybuffer';
    this.test.onopen = () => {
      this.testOpen = true;
      this._maybeReady();
    };
    this.test.onmessage = (e) => this._onTestMessage(e.data);
    this.test.onbufferedamountlow = () => {
      this.paused = false;
    };

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => this._sendWs({ t: 'offer', sdp: pc.localDescription.sdp }))
      .catch((err) => this.onEvent('error', { message: `createOffer 失败: ${err.message}` }));
  }

  _maybeReady() {
    if (this.ctrlOpen && this.testOpen && !this.negotiated) {
      this.negotiated = true;
      this.connected = true;
      this.onEvent('ready', {});
      if (this._negotiationResolve) {
        this._negotiationResolve();
        this._negotiationResolve = null;
      }
    }
  }

  _sendWs(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendCtrl(obj) {
    if (this.ctrl && this.ctrl.readyState === 'open') this.ctrl.send(JSON.stringify(obj));
  }

  _onWsMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'answer':
        this.haveAnswer = true;
        this.pc
          .setRemoteDescription({ type: 'answer', sdp: msg.sdp })
          .then(() => {
            for (const cand of this.pendingServerIce) this.pc.addIceCandidate(cand).catch(() => {});
            this.pendingServerIce = [];
          })
          .catch((err) => this.onEvent('error', { message: `setRemoteDescription 失败: ${err.message}` }));
        break;
      case 'ice':
        if (msg.candidate === null) break; // end-of-candidates
        if (!this.haveAnswer) {
          this.pendingServerIce.push({ candidate: msg.candidate, sdpMid: msg.mid, sdpMLineIndex: 0 });
        } else {
          this.pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid, sdpMLineIndex: 0 }).catch(() => {});
        }
        break;
      case 'peerState':
        this.onEvent('peerstate', { state: msg.state });
        break;
      case 'error':
        this.onEvent('error', { message: msg.message });
        break;
      default:
        break;
    }
  }

  _onCtrlMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'ready':
        this.onEvent('serverready', {});
        break;
      case 'live':
        this.onEvent('live', msg);
        break;
      case 'summary':
        this._finalize(msg);
        break;
      case 'error':
        this.onEvent('error', { message: msg.message });
        break;
      default:
        break;
    }
  }

  // ---- test run ------------------------------------------------------------

  _beginTest(cfg) {
    this._resetMeasurement(cfg);
    this.testStartAt = performance.now();
    this.warmupEndAt = this.testStartAt + WARMUP_MS;
    this.sendCtrl({
      t: 'start',
      cfg: { pps: cfg.pps, size: cfg.size, durationMs: cfg.durationMs, thresholdMs: cfg.thresholdMs },
    });
    this.onEvent('running', {});

    // pacing parameters
    const lowWater = Math.max(4 * cfg.size, 4096);
    this.test.bufferedAmountLowThreshold = lowWater;
    this.highWater = lowWater * 4;
    this.intervalMs = 1000 / cfg.pps;
    this.nextSendAt = performance.now() + this.intervalMs;
    this.timer = setTimeout(() => this._tick(), this.intervalMs);

    this._startProgress();
  }

  _resetMeasurement(cfg) {
    this.running = true;
    this.seq = 0;
    this.sentTotal = 0;
    this.paused = false;
    this.recvEchoSeen.clear();
    this.lastSrvRecvIdx = 0;
    this.rtts = [];
    this.prevRtt = null;
    this.jitterDeltas = [];
    this.lateCount = 0;
    this.statEchoCount = 0;
    this.buckets.clear();
    this.summary = null;
  }

  _tick() {
    this.nextSendAt += this.intervalMs;
    if (!this.running) return;
    if (this.paused) return this._scheduleTick();

    if (this.test && this.test.readyState === 'open') {
      if (this.test.bufferedAmount >= this.highWater) {
        this.paused = true; // local queue full — wait for bufferedamountlow
        return this._scheduleTick();
      }
      this._sendOne();
    }
    this._scheduleTick();
  }

  _scheduleTick() {
    const delay = Math.max(0, this.nextSendAt - performance.now());
    this.timer = setTimeout(() => this._tick(), delay);
  }

  _sendOne() {
    const now = performance.now();
    const frame = encodeDataFrame({ seq: ++this.seq, sendAt: now, size: this.cfg.size });
    try {
      this.test.send(frame);
      this.sentTotal++; // counted at the moment send() is called
    } catch (err) {
      this.onEvent('error', { message: `发送失败: ${err.message}` });
    }
  }

  _startProgress() {
    const endAt = this.testStartAt + this.cfg.durationMs;
    const iv = setInterval(() => {
      if (!this.running) {
        clearInterval(iv);
        return;
      }
      this.onEvent('progress', this.getLive());
      if (performance.now() >= endAt) {
        clearInterval(iv);
        this._finish();
      }
    }, 200);
  }

  _finish() {
    this.running = false;
    clearTimeout(this.timer);
    this.onEvent('stopping', {});
    this.sendCtrl({ t: 'stop' });

    // summary is authoritative on the reliable control channel; guard against loss
    setTimeout(() => {
      if (!this.summary) {
        this.onEvent('error', { message: '未在超时时间内收到服务器汇总,结果可能不完整。' });
        this._finalize(this._estimatedSummary());
      }
    }, SETTLE_TIMEOUT_MS);
  }

  // ---- measurement ---------------------------------------------------------

  _onTestMessage(data) {
    const f = decodeEchoFrame(data);
    if (!f) return;
    const now = performance.now();
    const rtt = now - f.sendAt;
    if (rtt < 0) return; // clock edge — ignore

    this.recvEchoSeen.add(f.srvEchoIdx);
    if (f.srvRecvIdx > this.lastSrvRecvIdx) this.lastSrvRecvIdx = f.srvRecvIdx;

    // stats exclude the warmup window
    if (now >= this.warmupEndAt) {
      this.rtts.push(rtt);
      this.statEchoCount++;
      if (this.prevRtt !== null) this.jitterDeltas.push(Math.abs(rtt - this.prevRtt));
      this.prevRtt = rtt;
      if (rtt > this.cfg.thresholdMs) this.lateCount++;
    }

    // trend buckets include everything
    const idx = Math.floor((now - this.testStartAt) / BUCKET_MS);
    const b = this.buckets.get(idx) || { n: 0, sum: 0, max: 0, late: 0 };
    b.n++;
    b.sum += rtt;
    if (rtt > b.max) b.max = rtt;
    if (rtt > this.cfg.thresholdMs) b.late++;
    this.buckets.set(idx, b);
  }

  getLive() {
    const n = this.rtts.length;
    const avgRtt = n ? this.rtts.reduce((a, b) => a + b, 0) / n : 0;
    return {
      elapsed: performance.now() - this.testStartAt,
      duration: this.cfg.durationMs,
      sentTotal: this.sentTotal,
      recvEcho: this.recvEchoSeen.size,
      avgRtt,
    };
  }

  getTrendSeries() {
    const idxs = [...this.buckets.keys()].sort((a, b) => a - b);
    return idxs.map((i) => {
      const b = this.buckets.get(i);
      return { t: (i * BUCKET_MS) / 1000, avg: b.sum / b.n, max: b.max, late: b.late };
    });
  }

  _finalize(summary) {
    if (this.summary) return;
    this.summary = summary;
    this.onEvent('done', this._computeResults(summary));
  }

  _estimatedSummary() {
    let maxEchoIdx = 0;
    for (const v of this.recvEchoSeen) maxEchoIdx = Math.max(maxEchoIdx, v);
    return {
      srvRecvCount: this.lastSrvRecvIdx,
      srvEchoCount: Math.max(this.lastSrvRecvIdx, maxEchoIdx),
      serverDropEchoCount: 0,
    };
  }

  _computeResults(summary) {
    const sentTotal = this.sentTotal;
    const uploadLossPct =
      sentTotal > 0 ? Math.max(0, ((sentTotal - summary.srvRecvCount) / sentTotal) * 100) : 0;
    const srvEcho = summary.srvEchoCount;
    const downloadLossPct =
      srvEcho > 0 ? Math.max(0, ((srvEcho - this.recvEchoSeen.size) / srvEcho) * 100) : 0;

    const sorted = [...this.rtts].sort((a, b) => a - b);
    const n = sorted.length;
    const avgRtt = n ? sorted.reduce((a, b) => a + b, 0) / n : 0;
    const medianRtt = percentile(sorted, 0.5);
    const p95Rtt = percentile(sorted, 0.95);
    const maxRtt = n ? sorted[n - 1] : 0;

    const jitterAvg = this.jitterDeltas.length
      ? this.jitterDeltas.reduce((a, b) => a + b, 0) / this.jitterDeltas.length
      : 0;
    const jitterMax = this.jitterDeltas.length ? Math.max(...this.jitterDeltas) : 0;

    const latePct = this.statEchoCount > 0 ? (this.lateCount / this.statEchoCount) * 100 : 0;

    const elapsedSec = Math.max(0.001, (performance.now() - this.testStartAt) / 1000);
    const sentPps = sentTotal / elapsedSec;
    const kbps = (sentTotal * this.cfg.size * 8) / 1000 / elapsedSec;

    return {
      sentTotal,
      srvRecv: summary.srvRecvCount,
      srvEcho,
      recvEcho: this.recvEchoSeen.size,
      serverDropEcho: summary.serverDropEchoCount ?? 0,
      uploadLossPct,
      downloadLossPct,
      avgRtt,
      medianRtt,
      p95Rtt,
      maxRtt,
      oneWayEstimate: avgRtt / 2,
      jitterAvg,
      jitterMax,
      lateCount: this.lateCount,
      latePct,
      thresholdMs: this.cfg.thresholdMs,
      durationMs: this.cfg.durationMs,
      size: this.cfg.size,
      pps: this.cfg.pps,
      sentPps,
      kbps,
      trend: this.getTrendSeries(),
    };
  }
}
