import { describe, expect, it } from 'vitest';
import { encodeFrame, encodeLine, FrameError, FrameReader, LineReader, MAX_HOST_TO_EXTENSION_BYTES } from './framing';

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('native messaging frames', () => {
  it('round-trips a message with a little-endian 4-byte length', () => {
    const frame = encodeFrame({ type: 'ready', n: 1 });
    const body = new TextEncoder().encode(JSON.stringify({ type: 'ready', n: 1 }));
    expect([...frame.slice(0, 4)]).toEqual([body.length, 0, 0, 0]);
    expect(new FrameReader().push(frame)).toEqual([{ type: 'ready', n: 1 }]);
  });

  it('counts bytes, not characters', () => {
    const message = { text: 'Привіт, світе 🌍' };
    const frame = encodeFrame(message);
    expect(new DataView(frame.buffer).getUint32(0, true)).toBe(frame.length - 4);
    expect(new FrameReader().push(frame)).toEqual([message]);
  });

  it('reassembles a frame delivered one byte at a time', () => {
    const frame = encodeFrame({ a: 'x'.repeat(50) });
    const reader = new FrameReader();
    const out: unknown[] = [];
    for (const byte of frame) out.push(...reader.push(Uint8Array.of(byte)));
    expect(out).toEqual([{ a: 'x'.repeat(50) }]);
    expect(reader.pending).toBe(0);
  });

  it('handles a split inside the length prefix and inside the body', () => {
    const frame = encodeFrame({ hello: 'world' });
    const reader = new FrameReader();
    expect(reader.push(frame.slice(0, 2))).toEqual([]);
    expect(reader.push(frame.slice(2, 7))).toEqual([]);
    expect(reader.push(frame.slice(7))).toEqual([{ hello: 'world' }]);
  });

  it('returns several frames from one chunk and keeps the partial one', () => {
    const a = encodeFrame({ n: 1 });
    const b = encodeFrame({ n: 2 });
    const c = encodeFrame({ n: 3 });
    const reader = new FrameReader();
    expect(reader.push(concat(a, b, c.slice(0, 3)))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(reader.pending).toBe(3);
    expect(reader.push(c.slice(3))).toEqual([{ n: 3 }]);
  });

  it('reads a zero-length-adjacent tiny frame and an empty chunk', () => {
    const reader = new FrameReader();
    expect(reader.push(new Uint8Array(0))).toEqual([]);
    expect(reader.push(encodeFrame(0))).toEqual([0]);
  });

  it('reads frames larger than 1 MiB (the extension may send big results to the host)', () => {
    const big = { data: 'a'.repeat(3 * 1024 * 1024) };
    const frame = encodeFrame(big, Infinity);
    const reader = new FrameReader();
    const out: unknown[] = [];
    for (let at = 0; at < frame.length; at += 64 * 1024) out.push(...reader.push(frame.subarray(at, at + 64 * 1024)));
    expect(out).toHaveLength(1);
    expect((out[0] as typeof big).data.length).toBe(big.data.length);
  });

  it('refuses to build a host-to-extension frame over Chrome\'s 1 MiB limit', () => {
    expect(() => encodeFrame({ data: 'a'.repeat(MAX_HOST_TO_EXTENSION_BYTES) })).toThrow(FrameError);
    expect(() => encodeFrame({ data: 'a'.repeat(1000) })).not.toThrow();
  });

  it('rejects an oversize announced length before buffering it', () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 5000, true);
    expect(() => new FrameReader(1000).push(header)).toThrow(FrameError);
  });

  it('rejects invalid JSON and invalid UTF-8', () => {
    const frame = (bytes: number[]) => concat(Uint8Array.of(bytes.length, 0, 0, 0), Uint8Array.from(bytes));
    expect(() => new FrameReader().push(frame([...new TextEncoder().encode('{nope')]))).toThrow(FrameError);
    expect(() => new FrameReader().push(frame([0xff, 0xfe, 0x22]))).toThrow(FrameError);
  });
});

describe('line framing (socket)', () => {
  it('splits on newlines across chunks', () => {
    const reader = new LineReader();
    expect(reader.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
    expect(reader.push(':2}\n\n')).toEqual([{ b: 2 }]);
  });

  it('round-trips encodeLine and rejects garbage', () => {
    expect(new LineReader().push(encodeLine({ x: 'é\n' }))).toEqual([{ x: 'é\n' }]);
    expect(() => new LineReader().push('not json\n')).toThrow(FrameError);
  });

  it('refuses an endless line', () => {
    expect(() => new LineReader(10).push('x'.repeat(11))).toThrow(FrameError);
  });
});
