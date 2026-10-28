import { readFile } from 'node:fs/promises';

const EMOJI_KEYS = Object.freeze([
  'btc', 'eth', 'sol', 'ltc', 'usdt', 'usdc', 'bnb', 'pol',
  'avax', 'doge', 'xrp', 'trx', 'sui', 'ada', 'bch', 'zec', 'xlm', 'apt',
  'near', 'ton',
]);

const EMOJI_REVISIONS = Object.freeze({ usdt: 2 });

const FALLBACK_EMOJIS = Object.freeze({
  btc: '🟠',
  eth: '🔷',
  sol: '🟣',
  ltc: '🔵',
  usdt: '🟢',
  usdc: '🔵',
  bnb: '🟡',
  pol: '🟣',
  avax: '🔺',
  doge: '🐕',
  xrp: '⚫',
  trx: '🔺',
  sui: '💧',
  ada: '🔵',
  bch: '🟢',
  zec: '🟡',
  xlm: '✨',
  apt: '⚫',
  near: '⚫',
  ton: '🔷',
  other: '🔎',
});

export class EmojiService {
  constructor({ client, logger }) {
    this.client = client;
    this.logger = logger;
    this.emojis = new Map();
  }

  async initialize() {
    try {
      const manager = this.client.application?.emojis;
      if (!manager) throw new Error('Discord application emoji manager is unavailable.');
      const existing = await manager.fetch();
      const byName = new Map([...existing.values()].map((emoji) => [emoji.name, emoji]));

      for (const key of EMOJI_KEYS) {
        const name = emojiName(key);
        let emoji = byName.get(name);
        if (!emoji) {
          try {
            const encoded = await readFile(new URL(`../assets/token-logos/${key}.b64`, import.meta.url), 'utf8');
            emoji = await manager.create({ attachment: Buffer.from(encoded.trim(), 'base64'), name });
            this.logger.info({ emojiName: name }, 'Discord application emoji created');
          } catch (error) {
            this.logger.warn({ emojiName: name, errorName: error.name }, 'Token logo emoji could not be created; using fallback');
            continue;
          }
        }
        this.emojis.set(key, { id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) });
        for (const obsoleteName of obsoleteEmojiNames(key)) {
          const obsolete = byName.get(obsoleteName);
          if (!obsolete || obsolete.id === emoji.id) continue;
          try {
            await manager.delete(obsolete);
            this.logger.info({ emojiName: obsoleteName }, 'Obsolete Discord application emoji removed');
          } catch (error) {
            this.logger.warn({ emojiName: obsoleteName, errorName: error.name }, 'Obsolete application emoji could not be removed');
          }
        }
      }
      this.logger.info({ customEmojiCount: this.emojis.size }, 'Token logo emoji synchronization complete');
    } catch (error) {
      this.logger.warn({ errorName: error.name }, 'Application emojis could not be fetched; using fallbacks');
    }
  }

  get(coinKey) {
    const key = String(coinKey ?? '').toLowerCase();
    return this.emojis.get(key) ?? FALLBACK_EMOJIS[key] ?? FALLBACK_EMOJIS.other;
  }
}

function emojiName(key) {
  const revision = EMOJI_REVISIONS[key];
  return revision ? `swap_${key}_v${revision}` : `swap_${key}`;
}

function obsoleteEmojiNames(key) {
  const revision = EMOJI_REVISIONS[key];
  if (!revision) return [];
  return [`swap_${key}`, ...Array.from({ length: revision - 1 }, (_, index) => `swap_${key}_v${index + 1}`)];
}
