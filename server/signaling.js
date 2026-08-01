// server/signaling.js
// WebSocket signaling for the WebRTC handshake. The browser is the offerer;
// we relay offer/answer/ICE over the WebSocket and hand the session to an
// EchoPeer. After negotiation all test traffic flows over the data channels,
// so the WebSocket is only used during setup.
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { EchoPeer } from './webrtc-peer.js';

export function setupSignaling(server) {
  const wss = new WebSocketServer({ server, path: config.signaling.path });

  wss.on('connection', (ws, req) => {
    const peer = new EchoPeer({
      send(json) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify(json));
          } catch {
            /* connection dying */
          }
        }
      },
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (process.env.PL_DEBUG) console.log(`[signaling] recv ${msg.t}`, msg.t === 'offer' ? `(sdp ${msg.sdp.length} chars)` : '');
      switch (msg.t) {
        case 'offer':
          peer.setRemoteOffer(msg.sdp);
          break;
        case 'ice':
          peer.addIce(msg.candidate, msg.mid);
          break;
        case 'bye':
          ws.close();
          break;
        default:
          break;
      }
    });

    ws.on('close', () => peer.destroy());
    ws.on('error', () => {});
  });

  return wss;
}
