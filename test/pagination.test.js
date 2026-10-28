import { describe, expect, it } from 'vitest';
import { paginate, truncate } from '../src/utils/pagination.js';

describe('Discord pagination', () => {
  const items = Array.from({ length: 61 }, (_, index) => `item-${index}`);

  it('uses Discord-safe pages of at most 25 choices', () => {
    expect(paginate(items, 0).items).toHaveLength(25);
    expect(paginate(items, 1).items).toHaveLength(25);
    expect(paginate(items, 2).items).toHaveLength(11);
  });

  it('clamps page indexes', () => {
    expect(paginate(items, -5).page).toBe(0);
    expect(paginate(items, 99).page).toBe(2);
  });

  it('truncates labels to Discord field limits', () => {
    expect(truncate('abcdefghij', 6)).toBe('abcde…');
  });
});
