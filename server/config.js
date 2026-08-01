// server/config.js
// Central configuration for the packet-loss tester.
// Values can be overridden via CLI flags or an optional (git-ignored)
// config.local.js that deep-merges on top of the defaults.
//
//   npm start -- --port 8787 --simulateLoss up=10,down=20,lat=50,jit=5
//   npm start -- --https --cert cert.pem --key key.pem
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- CLI parsing ----------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--simulateLoss') {
      const parts = {};
      for (const kv of (argv[++i] ?? '').split(',')) {
        const idx = kv.indexOf('=');
        if (idx === -1) continue;
        const k = kv.slice(0, idx).trim();
        const v = parseFloat(kv.slice(idx + 1).trim());
        if (k) parts[k] = v;
      }
      args.simulate = {
        enabled: true,
        uploadLoss: parts.up ?? 0,
        downloadLoss: parts.down ?? 0,
        latencyMs: parts.lat ?? 0,
        jitterMs: parts.jit ?? 0,
      };
    } else if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--https') args.https = true;
    else if (a === '--cert') args.cert = argv[++i];
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--bindAddress') args.bindAddress = argv[++i];
    else if (a === '--publicHostname') args.publicHostname = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ---- defaults -------------------------------------------------------------

const defaults = {
  http: { port: 8787, host: '0.0.0.0' },

  signaling: { path: '/ws' },

  // WebRTC settings for the Node side (the echo peer).
  serverIce: {
    iceServers: [],          // usually none needed; add STUN/TURN for public/NAT'd hosts
    bindAddress: null,       // e.g. the public IP on a multi-homed public server
    portRange: [49000, 49100],
    enableIceUdpMux: false,  // true = multiplex ICE/DTLS/SCTP onto one UDP port
  },

  // Public deployment. Required for browsers: RTCPeerConnection DataChannels
  // only work in a secure context (HTTPS). Terminate TLS with a reverse proxy
  // (Caddy/nginx + Let's Encrypt) or Cloudflare, and keep https=false below.
  public: {
    hostname: 'probe.starminus.uk', // 部署到日本 VPS 的访问域名
    https: false,
    certPemFile: null,
    keyPemFile: null,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], // public STUN; add TURN here
  },

  // Artificial impairment injection, used to validate the measurements.
  // CLI: --simulateLoss up=<%>,down=<%>,lat=<ms>,jit=<ms>
  simulate: { enabled: false, uploadLoss: 0, downloadLoss: 0, latencyMs: 0, jitterMs: 0 },

  // 单节点部署:就一个日本节点(url:null 表示用浏览器当前访问的 origin)。
  // 如需多地区节点,往这里加即可(如 { id:'jp2', label:'日本2', url:'https://xxx' })。
  servers: [
    { id: 'auto', label: '日本节点 (probe.starminus.uk)', url: null },
  ],

  publicDir: path.resolve(__dirname, '../public'),
};

// ---- apply CLI overrides --------------------------------------------------

const cfg = structuredClone(defaults);
if (args.port) cfg.http.port = args.port;
if (args.host) cfg.http.host = args.host;
if (args.https) cfg.public.https = true;
if (args.cert) cfg.public.certPemFile = args.cert;
if (args.key) cfg.public.keyPemFile = args.key;
if (args.bindAddress) cfg.serverIce.bindAddress = args.bindAddress;
if (args.publicHostname) cfg.public.hostname = args.publicHostname;
if (args.simulate) cfg.simulate = args.simulate;

// ---- optional git-ignored local override ----------------------------------

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
}

const localCfgFile = path.resolve(__dirname, 'config.local.js');
if (fs.existsSync(localCfgFile)) {
  const local = await import(pathToFileURL(localCfgFile));
  deepMerge(cfg, local.default ?? {});
}

export const config = cfg;
