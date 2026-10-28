import { describe, expect, it, vi } from 'vitest';
import { EmojiService } from '../src/services/emoji-service.js';

describe('application emoji synchronization', () => {
  it('creates the transparent Tether revision before deleting the obsolete emoji', async () => {
    const obsolete = { id: 'old-usdt', name: 'swap_usdt', animated: false };
    const events = [];
    const manager = {
      fetch: vi.fn().mockResolvedValue(new Map([[obsolete.id, obsolete]])),
      create: vi.fn(async ({ name }) => {
        events.push(`create:${name}`);
        return { id: `id-${name}`, name, animated: false };
      }),
      delete: vi.fn(async (emoji) => events.push(`delete:${emoji.name}`)),
    };
    const service = new EmojiService({
      client: { application: { emojis: manager } },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await service.initialize();

    expect(service.get('usdt')).toMatchObject({ name: 'swap_usdt_v2' });
    expect(events.indexOf('create:swap_usdt_v2')).toBeLessThan(events.indexOf('delete:swap_usdt'));
  });
});
