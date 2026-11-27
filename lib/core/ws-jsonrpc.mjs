// Minimal zero-dependency RFC 6455 client framing over a byte stream (stdin/stdout proxy).
// Used to speak WebSocket JSON-RPC with `codex app-server proxy`.
import crypto from 'node:crypto';
import { failure } from './outcome.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

export function upgradeRequest(path = '/', host = 'localhost') {
  const key = crypto.randomBytes(16).toString('base64');
  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  const text = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
  return { key, accept, text };
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (data.length > MAX_FRAME_BYTES) {
    throw failure('Outbound WebSocket frame exceeds 8 MiB limit.', 'message_too_long');
  }
  const mask = crypto.randomBytes(4);
  let headerLen = 2;
  if (data.length >= 126 && data.length <= 0xffff) headerLen += 2;
  else if (data.length > 0xffff) headerLen += 8;

  const out = Buffer.allocUnsafe(headerLen + 4 + data.length);
  out[0] = 0x80 | (opcode & 0x0f); // FIN=1
  if (data.length < 126) {
    out[1] = 0x80 | data.length;
  } else if (data.length <= 0xffff) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(data.length, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(data.length), 2);
  }
  mask.copy(out, headerLen);
  for (let i = 0; i < data.length; i++) {
    out[headerLen + 4 + i] = data[i] ^ mask[i & 3];
  }
  return out;
}

export const encodeText = text => encodeFrame(0x1, Buffer.from(String(text), 'utf8'));
export const encodePong = (payload = Buffer.alloc(0)) => encodeFrame(0xA, payload);
export function encodeClose(code = 1000) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16BE(code, 0);
  return encodeFrame(0x8, buf);
}

export class FrameDecoder {
  constructor({ accept }) {
    this.accept = accept;
    this.upgraded = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.fragmentBytes = 0;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const events = [];

    if (!this.upgraded) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          throw failure('WebSocket handshake response headers are too large.', 'protocol_incompatible');
        }
        return events;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString('latin1');
      this.buffer = this.buffer.subarray(headerEnd + 4);
      const lines = headerText.split('\r\n');
      if (!/^HTTP\/1\.1\s+101\b/i.test(lines[0] ?? '')) {
        throw failure(`WebSocket upgrade failed: ${lines[0] ?? 'empty status'}.`, 'protocol_incompatible');
      }
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
        }
      }
      if (headers.get('sec-websocket-accept') !== this.accept) {
        throw failure('WebSocket Sec-WebSocket-Accept mismatch.', 'protocol_incompatible');
      }
      this.upgraded = true;
      events.push({ type: 'open' });
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = Boolean(b0 & 0x80);
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let length = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        const err = failure('Unsupported WebSocket RSV bits.', 'protocol_incompatible');
        err.events = events;
        throw err;
      }
      if (length === 126) {
        if (this.buffer.length < offset + 2) break;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) break;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          const err = failure('Inbound WebSocket frame exceeds 8 MiB.', 'protocol_incompatible');
          err.events = events;
          throw err;
        }
        length = Number(big);
        offset += 8;
      }
      if (length > MAX_FRAME_BYTES) {
        const err = failure('Inbound WebSocket frame exceeds 8 MiB.', 'protocol_incompatible');
        err.events = events;
        throw err;
      }
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;

      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset - 4, offset);
        const unmasked = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i & 3];
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x9) {
        events.push({ type: 'ping', payload: Buffer.from(payload) });
      } else if (opcode === 0xA) {
        events.push({ type: 'pong', payload: Buffer.from(payload) });
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
        events.push({ type: 'close', code });
      } else if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) {
          if (this.fragments) {
            const err = failure('Interleaved WebSocket text frame.', 'protocol_incompatible');
            err.events = events;
            throw err;
          }
          if (fin) {
            try {
              events.push({ type: 'text', text: decoder.decode(payload) });
            } catch {
              const err = failure('WebSocket text frame is not valid UTF-8.', 'protocol_incompatible');
              err.events = events;
              throw err;
            }
          } else {
            this.fragments = [Buffer.from(payload)];
            this.fragmentBytes = payload.length;
          }
        } else {
          if (!this.fragments) {
            const err = failure('Unexpected WebSocket continuation frame.', 'protocol_incompatible');
            err.events = events;
            throw err;
          }
          this.fragmentBytes += payload.length;
          if (this.fragmentBytes > MAX_FRAME_BYTES) {
            const err = failure('Fragmented WebSocket message exceeds 8 MiB.', 'protocol_incompatible');
            err.events = events;
            throw err;
          }
          this.fragments.push(Buffer.from(payload));
          if (fin) {
            const combined = Buffer.concat(this.fragments);
            this.fragments = null;
            this.fragmentBytes = 0;
            try {
              events.push({ type: 'text', text: decoder.decode(combined) });
            } catch {
              const err = failure('WebSocket text message is not valid UTF-8.', 'protocol_incompatible');
              err.events = events;
              throw err;
            }
          }
        }
      } else {
        const err = failure(`Unsupported WebSocket opcode ${opcode}.`, 'protocol_incompatible');
        err.events = events;
        throw err;
      }
    }
    return events;
  }
}
