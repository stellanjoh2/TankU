// GIF89a frame decode. fire.gif gives every frame after the first its own palette.

function lzwDecode(src, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoi = clearCode + 1;
  const out = new Uint8Array(pixelCount);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clearCode; i++) suffix[i] = i;

  let codeSize = minCodeSize + 1;
  let nextCode = eoi + 1;
  let prev = -1;
  let firstByte = 0;
  let acc = 0;
  let bits = 0;
  let sp = 0;
  let si = 0;
  let oi = 0;

  const readCode = () => {
    while (bits < codeSize) {
      if (si >= src.length) return -1;
      acc |= src[si++] << bits;
      bits += 8;
    }
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;
    return code;
  };

  while (oi < pixelCount) {
    const code = readCode();
    if (code < 0 || code === eoi) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = eoi + 1;
      prev = -1;
      continue;
    }

    let walk = code;
    if (code === nextCode) {
      stack[sp++] = firstByte;
      walk = prev;
    } else if (code > nextCode) {
      break;
    }
    while (walk >= clearCode) {
      stack[sp++] = suffix[walk];
      walk = prefix[walk];
    }
    firstByte = suffix[walk];
    stack[sp++] = firstByte;
    while (sp > 0) out[oi++] = stack[--sp];

    if (prev >= 0 && nextCode < 4096) {
      prefix[nextCode] = prev;
      suffix[nextCode] = firstByte;
      nextCode++;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

function skipSubBlocks(bytes, i) {
  while (i < bytes.length) {
    const sz = bytes[i++];
    if (sz === 0) break;
    i += sz;
  }
  return i;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{ width: number, height: number, frames: Uint8Array[], palettes: Uint8Array[], transparent: number, delays: number[] }}
 * `palettes[i]` is that frame's local color table, or the global one when the frame has none.
 * delays are seconds. `transparent` is the palette index to key out, or -1.
 */
export function decodeGif(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {
    throw new Error('not a GIF');
  }
  let i = 6;
  const width = bytes[i] | (bytes[i + 1] << 8);
  const height = bytes[i + 2] | (bytes[i + 3] << 8);
  i += 4;
  const packed = bytes[i++];
  i += 2; // background, aspect
  let palette = null;
  if (packed & 0x80) {
    const n = 3 * (2 ** ((packed & 7) + 1));
    palette = bytes.slice(i, i + n);
    i += n;
  }

  const frames = [];
  const palettes = [];
  const delays = [];
  let pendingDelay = 0.1;
  let transparent = -1;
  const pixelCount = width * height;

  while (i < bytes.length) {
    const b = bytes[i++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[i++];
      if (label === 0xf9) {
        const block = bytes[i++];
        const flags = bytes[i];
        const cs = bytes[i + 1] | (bytes[i + 2] << 8);
        const tindex = bytes[i + 3];
        i += block;
        i++; // terminator
        // Delay is centiseconds; 0 means "as fast as possible" — treat as 10cs.
        pendingDelay = (cs < 2 ? 10 : cs) / 100;
        if (flags & 1) transparent = tindex;
      } else {
        i = skipSubBlocks(bytes, i);
      }
      continue;
    }
    if (b !== 0x2c) throw new Error(`bad GIF block ${b} at ${i - 1}`);
    i += 8; // x, y, w, h
    const ipacked = bytes[i++];
    let framePalette = palette;
    if (ipacked & 0x80) {
      const n = 3 * (2 ** ((ipacked & 7) + 1));
      framePalette = bytes.slice(i, i + n);
      i += n;
    }
    const minCodeSize = bytes[i++];
    const chunks = [];
    let total = 0;
    while (i < bytes.length) {
      const sz = bytes[i++];
      if (sz === 0) break;
      chunks.push(bytes.subarray(i, i + sz));
      total += sz;
      i += sz;
    }
    const compressed = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      compressed.set(c, o);
      o += c.length;
    }
    frames.push(lzwDecode(compressed, minCodeSize, pixelCount));
    palettes.push(framePalette);
    delays.push(pendingDelay);
  }

  if (!palette || frames.length === 0) throw new Error('GIF has no frames');
  return { width, height, frames, palettes, transparent, delays };
}
