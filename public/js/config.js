// public/js/config.js
// Client-side configuration: presets, duration options, and the /config fetch
// that tells us which ICE servers to use for this deployment (local vs public).

/** 测试预设(默认 / 游戏 FPS / VoIP / 视频通话 / 流媒体)。 */
export const PRESETS = {
  default: {
    id: 'default',
    label: '默认',
    pps: 15,
    size: 212,
    thresholdMs: 200,
    desc: '均衡',
  },
  fps: {
    id: 'fps',
    label: '游戏（FPS）',
    pps: 64,
    size: 200,
    thresholdMs: 80,
    desc: '小包高频,亚 100ms 才可用',
  },
  voip: {
    id: 'voip',
    label: 'VoIP',
    pps: 50,
    size: 160,
    thresholdMs: 150,
    desc: '语音通话负载',
  },
  video: {
    id: 'video',
    label: '视频通话',
    pps: 30,
    size: 1200,
    thresholdMs: 300,
    desc: '接近 MTU 的 RTP 包',
  },
  streaming: {
    id: 'streaming',
    label: '流媒体',
    pps: 10,
    size: 512,
    thresholdMs: 500,
    desc: '低频中包,容忍高延迟',
  },
};

export const DURATIONS = [
  { value: 5, label: '5 秒' },
  { value: 10, label: '10 秒' },
  { value: 30, label: '30 秒' },
  { value: 60, label: '60 秒' },
];

let cached = null;

/** Fetch /config once and cache the result. */
export async function getServerConfig() {
  if (cached) return cached;
  const res = await fetch('/config');
  if (!res.ok) throw new Error(`/config 请求失败 (HTTP ${res.status})`);
  cached = await res.json();
  return cached;
}

/** WebSocket signaling URL for the current origin. */
export function signalingUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
