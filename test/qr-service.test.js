import { describe, expect, it } from 'vitest';
import { QrService } from '../src/services/qr-service.js';

describe('deposit QR service', () => {
  it('creates a local PNG from the address value', async () => {
    const png = await new QrService().createDepositAddressPng('bc1qexampledepositaddress123456789');
    expect(Buffer.isBuffer(png)).toBe(true);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('rejects unusable address values', async () => {
    await expect(new QrService().createDepositAddressPng('x')).rejects.toThrow('cannot be encoded');
  });
});
