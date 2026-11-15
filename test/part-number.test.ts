import { describe, expect, it } from 'vitest';
import { looksLikePartNumber, normalisePartNumber } from '../src/lib/part-number.js';

describe('normalisePartNumber (v1 cases)', () => {
  it('collapses brand separators to one key', () => {
    for (const v of ['332/X5626', '332-x5626', ' 332 X5626 ', '332.X5626', '332–X5626', '332 X5626']) {
      expect(normalisePartNumber(v)).toBe('332X5626');
    }
  });
  it('removes the Excel float suffix but keeps real trailing zeros', () => {
    expect(normalisePartNumber('450112.0')).toBe('450112');
    expect(normalisePartNumber('4501120')).toBe('4501120');
  });
  it('tells part numbers from descriptions', () => {
    expect(looksLikePartNumber('DH-10442')).toBe(true);
    expect(looksLikePartNumber('80mm flail hammer heavy duty')).toBe(false);
  });
});
