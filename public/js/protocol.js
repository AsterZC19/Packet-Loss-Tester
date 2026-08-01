// public/js/protocol.js
// Binary frame codec shared by the client measurement engine.
//
// Frame layouts (big-endian), length always equals the configured packet size:
//   DATA: [0x01][seq u32 @1][sendAt f64 @5][padding ...]
//   ECHO: [0x02][seq u32 @1][sendAt f64 @5][srvRecvIdx u32 @13]
//         [srvEchoIdx u32 @17][padding ...]

export const FRAME_DATA = 0x01;
export const FRAME_ECHO = 0x02;
export const HEADER_LEN = 21; // bytes of header both sides agree on

/** Build a padded DATA frame of `size` bytes. */
export function encodeDataFrame({ seq, sendAt, size }) {
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, FRAME_DATA);
  dv.setUint32(1, seq, false);
  dv.setFloat64(5, sendAt, false);
  return buf;
}

/** Decode an ECHO frame. Returns null if it isn't one. */
export function decodeEchoFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < HEADER_LEN) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(0) !== FRAME_ECHO) return null;
  return {
    seq: dv.getUint32(1, false),
    sendAt: dv.getFloat64(5, false),
    srvRecvIdx: dv.getUint32(13, false),
    srvEchoIdx: dv.getUint32(17, false),
  };
}
