/**
 * BranchKit Browser — grammar-epoch digest golden vectors.
 *
 * MIRRORS plugins/browser src/batch_epoch_test.go exactly. These pin the
 * wire protocol: if either side's vectors change, every batch flags a false
 * epoch mismatch. Treat edits here as protocol changes, not refactors.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { epochHashOf } from './grammar-epoch';

describe('epochHashOf golden vectors (mirror of batch_epoch_test.go)', () => {
  it('empty set', () => {
    expect(epochHashOf([])).toBe('0000000000000000');
  });

  it('single', () => {
    expect(epochHashOf(['arch'])).toBe('893c43843eb23369');
  });

  it('single two-word codeword', () => {
    expect(epochHashOf(['arch bake'])).toBe('7772342a4b51cfbe');
  });

  it('pair', () => {
    expect(epochHashOf(['arch', 'bake'])).toBe('1317921f94a26349');
  });

  it('pair reversed (order-insensitive)', () => {
    expect(epochHashOf(['bake', 'arch'])).toBe('1317921f94a26349');
  });
});

describe('epochHashOf algebra', () => {
  it('is self-inverse: add then remove restores the digest', () => {
    const before = epochHashOf(['arch', 'bake']);
    const withExtra = epochHashOf(['arch', 'bake', 'gust harp']);
    expect(withExtra).not.toBe(before);
    expect(epochHashOf(['arch', 'bake'])).toBe(before);
  });
});
