// server/index.js — entry point.
// HTTP(S) server + static files + /config + WebSocket signaling.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { config } from './config.js';
import { serveStatic } from './static.js';
import { setupSignaling } from './signaling.js';

// ---- /config response -----------------------------------------------------

// /config returns the ICE servers the browser should use. With the bundled STUN
// responder removed, this is simply the configured public STUN/TURN array
// (defaults to Google's public STUN). TURN can be added for restrictive NATs.
function buildConfigResponse() {
  return {
    iceServers: config.public.iceServers,
    servers: config.servers,
    signalingPath: config.signaling.path,
    simulate: config.simulate.enabled,
    serverIce: {
      // whether the node peer uses a single UDP port range (for firewall docs)
      udpMux: config.serverIce.enableIceUdpMux,
      portRange: config.serverIce.portRange,
    },
  };
}

// ---- HTTP(S) server -------------------------------------------------------

function makeServer() {
  const handler = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/config') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(buildConfigResponse()));
      return;
    }
    serveStatic(config.publicDir)(req, res, url);
  };

  if (config.public.https) {
    if (!config.public.certPemFile || !config.public.keyPemFile) {
      console.error('[index] --https requires --cert and --key');
      process.exit(1);
    }
    const httpsOpts = {
      cert: fs.readFileSync(config.public.certPemFile),
      key: fs.readFileSync(config.public.keyPemFile),
    };
    return https.createServer(httpsOpts, handler);
  }
  return http.createServer(handler);
}

// ---- main -----------------------------------------------------------------

const server = makeServer();

setupSignaling(server);

server.listen(config.http.port, config.http.host, () => {
  const scheme = config.public.https ? 'https' : 'http';
  const shownHost = config.http.host === '0.0.0.0' ? 'localhost' : config.http.host;
  console.log(`[index] server listening on ${scheme}://${shownHost}:${config.http.port}`);
  console.log(`[index] signaling at ${scheme}://${shownHost}:${config.http.port}${config.signaling.path}`);
  if (config.simulate.enabled) {
    console.log(`[index] SIMULATE enabled: up=${config.simulate.uploadLoss}% down=${config.simulate.downloadLoss}% lat=${config.simulate.latencyMs}ms jit=${config.simulate.jitterMs}ms`);
  }
});

function shutdown() {
  console.log('\n[index] shutting down...');
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
