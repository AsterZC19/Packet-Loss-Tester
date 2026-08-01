// public/js/app.js — UI controller.
import { PRESETS, DURATIONS, getServerConfig, signalingUrl } from './config.js';
import { WebrtcTestClient } from './webrtc-client.js';
import { TrendChart } from './chart.js';
import { gradeQuality } from './quality.js';

const $ = (id) => document.getElementById(id);

const els = {
  server: $('server'),
  manualRow: $('manual-row'),
  manualUrl: $('manual-url'),
  presets: $('presets'),
  pps: $('pps'),
  size: $('size'),
  threshold: $('threshold'),
  duration: $('duration'),
  startBtn: $('start-btn'),
  status: $('status'),

  livePanel: $('live-panel'),
  progressFill: $('progress-fill'),
  progressLabel: $('progress-label'),
  liveSent: $('live-sent'),
  liveRecv: $('live-recv'),
  liveRtt: $('live-rtt'),

  resultPanel: $('result-panel'),
  gradeBox: $('grade-box'),
  gradeLetter: $('grade-letter'),
  gradeScore: $('grade-score'),
  gradeReason: $('grade-reason'),
  upLoss: $('up-loss'),
  downLoss: $('down-loss'),
  rttAvg: $('rtt-avg'),
  rttMedian: $('rtt-median'),
  rttP95: $('rtt-p95'),
  rttMax: $('rtt-max'),
  jitterAvg: $('jitter-avg'),
  jitterMax: $('jitter-max'),
  late: $('late'),
  throughput: $('throughput'),
  meta: $('result-meta'),
  chart: $('chart-live'),
  chartResult: $('chart-result'),
};

let client = null;
let iceServers = [];
let running = false;
const chart = new TrendChart(els.chart);
const chartResult = new TrendChart(els.chartResult);

// ---- helpers ---------------------------------------------------------------

// 单位统一:toFixed(1) + 无空格单位,如 "12.3ms" / "0.5%"
const ms = (n) => `${n.toFixed(1)}ms`;
const pct = (n) => `${n.toFixed(1)}%`;
const setStatus = (text) => {
  els.status.textContent = text;
};
const setError = (text) => {
  els.status.textContent = `⚠ ${text}`;
  els.status.classList.add('error');
};
const clearError = () => els.status.classList.remove('error');

// ---- init ------------------------------------------------------------------

async function init() {
  let cfg;
  try {
    cfg = await getServerConfig();
  } catch (err) {
    setError(`无法加载配置: ${err.message}`);
    els.startBtn.disabled = true;
    return;
  }
  iceServers = cfg.iceServers;

  for (const s of cfg.servers) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    els.server.appendChild(opt);
  }
  const manualOpt = document.createElement('option');
  manualOpt.value = 'manual';
  manualOpt.textContent = '手动服务器…';
  els.server.appendChild(manualOpt);

  // UDP 配置预设 —— 一排可点击的按钮,点击后联动更新参数输入框
  for (const p of Object.values(PRESETS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.dataset.preset = p.id;
    btn.textContent = p.label;
    btn.title = p.desc;
    btn.addEventListener('click', () => applyPreset(p));
    els.presets.appendChild(btn);
  }

  for (const d of DURATIONS) {
    const opt = document.createElement('option');
    opt.value = d.value;
    opt.textContent = d.label;
    els.duration.appendChild(opt);
  }
  els.duration.value = '10'; // 默认 10s

  // 手动改参数后,取消当前预设的高亮(表示这是自定义配置)
  for (const id of ['pps', 'size', 'threshold']) {
    $(id).addEventListener('input', () => setPresetActive(null));
  }

  els.server.addEventListener('change', onServerChange);
  els.startBtn.addEventListener('click', onStartClick);

  applyPreset(PRESETS.default);
  onServerChange();
  setStatus('就绪 — 选择配置后点击开始测试');
}

function applyPreset(p) {
  els.pps.value = p.pps;
  els.size.value = p.size;
  els.threshold.value = p.thresholdMs;
  setPresetActive(p.id);
}

function setPresetActive(id) {
  for (const btn of els.presets.querySelectorAll('.preset-btn')) {
    btn.classList.toggle('active', btn.dataset.preset === id);
  }
}

function onServerChange() {
  els.manualRow.style.display = els.server.value === 'manual' ? '' : 'none';
}

function currentCfg() {
  return {
    pps: parseInt(els.pps.value, 10) || 15,
    size: parseInt(els.size.value, 10) || 212,
    thresholdMs: parseInt(els.threshold.value, 10) || 200,
    durationMs: (parseInt(els.duration.value, 10) || 10) * 1000,
  };
}

// ---- start / stop ----------------------------------------------------------

async function onStartClick() {
  if (running) {
    client.cancel();
    return;
  }

  if (els.server.value === 'manual') {
    const url = els.manualUrl.value.trim();
    if (url) {
      location.href = url.includes('://') ? url : `http://${url}`;
      return;
    }
    setError('请先输入目标服务器地址');
    return;
  }

  const cfg = currentCfg();
  els.resultPanel.hidden = true;
  els.livePanel.hidden = false;
  els.livePanel.classList.remove('hidden');
  chart.reset({ thresholdMs: cfg.thresholdMs, durationMs: cfg.durationMs / 1000 });
  chart.setSeries([]);

  clearError();
  setStatus('正在连接信令服务器…');
  els.startBtn.textContent = '取消';
  running = true;

  try {
    client = new WebrtcTestClient({
      wsUrl: signalingUrl(),
      iceServers,
      onEvent: onClientEvent,
    });
    await client.start(cfg);
  } catch (err) {
    setError(err.message);
    resetBtn();
  }
}

function resetBtn() {
  running = false;
  els.startBtn.textContent = '开始测试';
  els.startBtn.disabled = false;
}

function onClientEvent(type, payload) {
  switch (type) {
    case 'ready':
      setStatus('连接已建立,开始测试…');
      break;
    case 'running':
      setStatus('测试进行中…');
      break;
    case 'ice':
      if (payload.state === 'connected') setStatus('正在发送测试数据包…');
      break;
    case 'progress':
      updateLive(payload);
      break;
    case 'stopping':
      setStatus('正在等待服务器汇总…');
      break;
    case 'done':
      renderResults(payload);
      break;
    case 'error':
      setError(payload.message);
      resetBtn();
      break;
    case 'cancelled':
      setStatus('已取消');
      els.startBtn.textContent = '开始测试';
      running = false;
      break;
    case 'wsclosed':
      if (running) {
        setError('信令连接已断开');
        resetBtn();
      }
      break;
    default:
      break;
  }
}

function updateLive(l) {
  const pctDone = Math.min(100, (l.elapsed / l.duration) * 100);
  els.progressFill.style.width = `${pctDone}%`;
  els.progressLabel.textContent = `${(l.elapsed / 1000).toFixed(1)}s / ${(l.duration / 1000).toFixed(0)}s`;
  els.liveSent.textContent = `${l.sentTotal} 包`;
  els.liveRecv.textContent = `${l.recvEcho} 包`;
  els.liveRtt.textContent = ms(l.avgRtt);
  chart.setSeries(client.getTrendSeries());
}

// ---- results ---------------------------------------------------------------

function renderResults(r) {
  running = false;
  els.startBtn.textContent = '重新测试';
  els.startBtn.disabled = false;
  els.livePanel.hidden = true;
  els.resultPanel.hidden = false;

  const g = gradeQuality(r);
  els.gradeBox.style.background = g.tint;
  els.gradeBox.style.borderColor = g.color;
  els.gradeLetter.textContent = g.grade;
  els.gradeLetter.style.color = g.color;
  els.gradeLetter.style.borderColor = g.color;
  els.gradeScore.style.color = g.ink;
  els.gradeScore.textContent = `综合得分 ${g.score} / 100`;
  els.gradeReason.style.color = g.ink;
  els.gradeReason.textContent = g.reason;

  els.upLoss.textContent = pct(r.uploadLossPct);
  els.downLoss.textContent = pct(r.downloadLossPct);
  els.rttAvg.textContent = ms(r.avgRtt);
  els.rttMedian.textContent = ms(r.medianRtt);
  els.rttP95.textContent = ms(r.p95Rtt);
  els.rttMax.textContent = ms(r.maxRtt);
  els.jitterAvg.textContent = ms(r.jitterAvg);
  els.jitterMax.textContent = ms(r.jitterMax);
  els.late.textContent = `${r.lateCount} 包 (${pct(r.latePct)})`;
  els.throughput.textContent = `${r.sentPps.toFixed(0)} pps · ${r.kbps.toFixed(0)} kbps 上行`;

  chart.reset({ thresholdMs: r.thresholdMs, durationMs: r.durationMs / 1000 });
  chartResult.reset({ thresholdMs: r.thresholdMs, durationMs: r.durationMs / 1000 });
  chartResult.setSeries(r.trend);

  els.meta.textContent =
    `发送 ${r.sentTotal} 包 / 服务器收到 ${r.srvRecv} 包 / 回显 ${r.srvEcho} 包 / 客户端收到 ${r.recvEcho} 包` +
    (r.serverDropEcho ? ` · 服务器因背压丢弃回显 ${r.serverDropEcho} 包` : '');

  setStatus('测试完成 ✓');
}

window.addEventListener('beforeunload', () => {
  if (client) client.destroy();
});

init();
