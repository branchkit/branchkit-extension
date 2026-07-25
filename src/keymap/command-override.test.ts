import { describe, it, expect } from 'vitest';
import {
  captureTokens,
  overrideKey,
  validateOverridePhrase,
  effectiveVoice,
  overridesFromList,
} from './command-override';

describe('overridesFromList + effectiveVoice', () => {
  const list = [
    { action: 'toggle_hints', default_pattern: 'toggle', new_pattern: 'hints' },
    { action: 'scroll', default_pattern: 'scroll down {number}', new_pattern: 'zoom {number}' },
  ];

  it('applies a matching override and leaves others as-is', () => {
    const ov = overridesFromList(list);
    expect(effectiveVoice('toggle_hints', ['toggle'], ov)).toEqual(['hints']);
    expect(effectiveVoice('scroll', ['scroll down', 'scroll down {number}'], ov))
      .toEqual(['scroll down', 'zoom {number}']);
  });

  it('is a no-op with no overrides', () => {
    expect(effectiveVoice('toggle_hints', ['toggle'])).toEqual(['toggle']);
    expect(effectiveVoice('toggle_hints', ['toggle'], new Map())).toEqual(['toggle']);
  });

  it('does not cross command ids', () => {
    const ov = overridesFromList(list);
    // Same default pattern text under a different command id must not match.
    expect(effectiveVoice('other', ['toggle'], ov)).toEqual(['toggle']);
  });
});

describe('captureTokens', () => {
  it('extracts and sorts {..} tokens, ignoring literals', () => {
    expect(captureTokens('scroll down {number}')).toEqual(['{number}']);
    expect(captureTokens('no captures')).toEqual([]);
    expect(captureTokens('go {b} then {a}')).toEqual(['{a}', '{b}']);
  });
});

describe('overrideKey', () => {
  it('is deterministic and collision-safe across space-bearing inputs', () => {
    expect(overrideKey('scroll', 'down')).toBe(overrideKey('scroll', 'down'));
    // (action "a b", pattern "c") must not collide with (action "a", pattern "b c").
    expect(overrideKey('a b', 'c')).not.toBe(overrideKey('a', 'b c'));
  });
});

describe('validateOverridePhrase', () => {
  it('accepts a literal rename', () => {
    expect(validateOverridePhrase('toggle', 'hints')).toBeNull();
  });

  it('accepts a capture-preserving rename', () => {
    expect(validateOverridePhrase('scroll down {number}', 'zoom {number}')).toBeNull();
  });

  it('accepts reordered literals around a closed capture', () => {
    expect(validateOverridePhrase('scroll down {number}', '{number} zoom')).toBeNull();
  });

  it('rejects empty', () => {
    expect(validateOverridePhrase('toggle', '   ')).toMatch(/enter a phrase/i);
  });

  it('rejects a dropped placeholder', () => {
    expect(validateOverridePhrase('scroll down {number}', 'zoom')).toMatch(/placeholder/i);
  });

  it('rejects an added placeholder', () => {
    expect(validateOverridePhrase('toggle', 'toggle {number}')).toMatch(/placeholder/i);
  });

  it('rejects non-lowercase literals', () => {
    expect(validateOverridePhrase('toggle', 'Hints')).toMatch(/lowercase/i);
    expect(validateOverridePhrase('toggle', 'hint2')).toMatch(/lowercase/i);
    expect(validateOverridePhrase('toggle', 'hint-mode')).toMatch(/lowercase/i);
  });

  it('rejects a free-text capture that is not last', () => {
    expect(validateOverridePhrase('find {text}', 'find {text} now')).toMatch(/last word/i);
  });

  it('rejects a phrase beginning with a free-text slot', () => {
    expect(validateOverridePhrase('find {text}', '{text}')).toMatch(/begin with a free-text/i);
  });

  it('requires the hint slot to stay last', () => {
    expect(validateOverridePhrase('blank {hint}', 'grab {hint}')).toBeNull();
    expect(validateOverridePhrase('blank {hint}', '{hint} grab')).toMatch(/last word/i);
  });
});
