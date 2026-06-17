import { describe, it, expect } from 'vitest';
import { parseVoiceCommands } from './voice-commands';

const SAMPLE = {
  active_tags: ['plugin.browser.hints'],
  eligible: [
    { owner: 'browser', pattern: 'show', action: 'browser.show_hints', requires_tags: [] },
    { owner: 'browser', pattern: 'show all', action: 'browser.show_hints', requires_tags: [] },
    { owner: 'browser', pattern: 'hide', action: 'browser.hide_hints', requires_tags: [] },
    { owner: 'tiling', pattern: 'snap left', action: 'tiling.snap', requires_tags: [] },
  ],
  gated: [
    { owner: 'browser', pattern: 'next tab', action: 'browser.next_tab', requires_tags: ['x'] },
    { owner: 'windows', pattern: 'maximize', action: 'windows.maximize', requires_tags: ['y'] },
  ],
};

describe('parseVoiceCommands', () => {
  it('maps browser actions to command ids, collecting phrases', () => {
    const m = parseVoiceCommands(SAMPLE);
    expect(m.get('show_hints')?.map((p) => p.phrase)).toEqual(['show', 'show all']);
    expect(m.get('hide_hints')?.map((p) => p.phrase)).toEqual(['hide']);
    expect(m.get('next_tab')?.map((p) => p.phrase)).toEqual(['next tab']);
  });

  it('marks eligible vs gated', () => {
    const m = parseVoiceCommands(SAMPLE);
    expect(m.get('show_hints')?.[0].eligible).toBe(true);
    expect(m.get('next_tab')?.[0].eligible).toBe(false);
  });

  it('ignores non-browser owners', () => {
    const m = parseVoiceCommands(SAMPLE);
    expect(m.has('snap')).toBe(false);
    expect(m.has('maximize')).toBe(false);
    expect([...m.keys()].sort()).toEqual(['hide_hints', 'next_tab', 'show_hints']);
  });

  it('dedupes a phrase that appears in both eligible and gated (eligible wins)', () => {
    const m = parseVoiceCommands({
      eligible: [{ owner: 'browser', pattern: 'show', action: 'browser.show_hints' }],
      gated: [{ owner: 'browser', pattern: 'show', action: 'browser.show_hints' }],
    });
    expect(m.get('show_hints')).toEqual([{ phrase: 'show', eligible: true }]);
  });

  it('is robust to junk input', () => {
    expect(parseVoiceCommands(null).size).toBe(0);
    expect(parseVoiceCommands({}).size).toBe(0);
    expect(parseVoiceCommands({ eligible: [{ owner: 'browser' }] }).size).toBe(0); // no action/pattern
  });
});
