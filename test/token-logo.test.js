import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

describe('bundled Tether logo', () => {
  it('is a 128x128 RGBA PNG with transparent corners', async () => {
    const encoded = await readFile(new URL('../src/assets/token-logos/usdt.b64', import.meta.url), 'utf8');
    const png = decodeRgbaPng(Buffer.from(encoded.trim(), 'base64'));
    expect([png.width, png.height]).toEqual([128, 128]);
    expect(png.pixel(0, 0)[3]).toBe(0);
    expect(png.pixel(127, 0)[3]).toBe(0);
    expect(png.pixel(0, 127)[3]).toBe(0);
    expect(png.pixel(127, 127)[3]).toBe(0);
    expect(png.pixel(64, 64)[3]).toBe(255);
  });
});

function decodeRgbaPng(buffer) {
  let offset = 8;
  let width;
  let height;
  const compressed = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    } else if (type === 'IDAT') compressed.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    const filter = raw[rowOffset];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowOffset + 1 + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      pixels[y * stride + x] = unfilter(value, filter, left, above, upperLeft);
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => [...pixels.subarray(y * stride + x * 4, y * stride + x * 4 + 4)],
  };
}

function unfilter(value, filter, left, above, upperLeft) {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 0xff;
  if (filter === 2) return (value + above) & 0xff;
  if (filter === 3) return (value + Math.floor((left + above) / 2)) & 0xff;
  if (filter === 4) return (value + paeth(left, above, upperLeft)) & 0xff;
  throw new Error(`Unsupported PNG filter ${filter}`);
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}
