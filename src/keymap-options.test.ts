import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openInlineEditor, cloneKeymap } from './keymap-options';

describe('cloneKeymap (staged-edit isolation)', () => {
  it('produces independent entry + params objects so draft edits never touch the baseline', () => {
    const baseline = [
      { keys: 'KeyJ', command: 'scroll_down' },
      { keys: 'KeyG', command: 'goto_tab', params: { index: '1' } },
    ];
    const draft = cloneKeymap(baseline);

    // Mutate the draft the way the editor does (in place).
    draft[0].keys = 'shift+KeyJ';
    draft[1].params!.index = '5';

    expect(baseline[0].keys).toBe('KeyJ');
    expect(baseline[1].params!.index).toBe('1');
    // And the clone is value-equal to a fresh clone of the same input.
    expect(cloneKeymap(baseline)).toEqual(baseline);
  });
});

// Behavior of the shared inline phrase editor — the dismissal handling the
// first cut lacked (blur/Escape cancel + close, Enter commits).

function mount(): { container: HTMLElement; input: () => HTMLInputElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    input: () => container.querySelector('input') as HTMLInputElement,
  };
}

function spec(over: Partial<Parameters<typeof openInlineEditor>[0]> = {}) {
  const commit = vi.fn();
  const restore = vi.fn();
  const m = mount();
  openInlineEditor({
    base: 'scroll down',
    initial: '',
    ariaLabel: 'test',
    mount: (editor) => m.container.appendChild(editor),
    restore,
    commit,
    ...over,
  });
  return { commit, restore, input: m.input() };
}

describe('openInlineEditor', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('blur (click-away) cancels and closes without committing', () => {
    const { commit, restore, input } = spec({ initial: 'zoom' });
    input.dispatchEvent(new Event('blur'));
    expect(restore).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('Escape cancels', () => {
    const { commit, restore, input } = spec({ initial: 'zoom' });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(restore).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('Enter commits a valid, non-empty value', () => {
    const { commit, restore } = ((): ReturnType<typeof spec> => {
      const s = spec();
      s.input.value = 'zoom';
      s.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      return s;
    })();
    expect(commit).toHaveBeenCalledWith('zoom');
    expect(restore).not.toHaveBeenCalled();
  });

  it('Enter on an empty field cancels (nothing to add)', () => {
    const { commit, restore, input } = spec();
    input.value = '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(restore).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('Enter on an invalid phrase stays open (no commit, no cancel)', () => {
    // Base has no captures; dropping/adding a placeholder is invalid.
    const { commit, restore, input } = spec({ base: 'toggle' });
    input.value = 'Hints'; // uppercase → invalid literal
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(commit).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(input.classList.contains('invalid')).toBe(true);
  });

  it('does not double-fire: after Enter commits, a trailing blur is a no-op', () => {
    const { commit, restore, input } = spec();
    input.value = 'zoom';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    input.dispatchEvent(new Event('blur')); // as would happen when the row re-renders
    expect(commit).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
  });

  it('treats an unchanged value as a cancel via isNoChange', () => {
    const { commit, restore, input } = spec({ initial: 'scroll down', isNoChange: (v) => v === 'scroll down' });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(commit).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
  });
});
