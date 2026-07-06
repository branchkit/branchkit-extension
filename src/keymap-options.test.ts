import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openInlineEditor, cloneKeymap, capture } from './keymap-options';

describe('capture (key-rebind prompt)', () => {
  // A couple of tests intentionally leave a capture active; finish it so its
  // window keydown/pointerdown listeners don't leak into later suites.
  afterEach(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    document.body.replaceChildren();
  });

  function setup(): HTMLButtonElement {
    const keys = document.createElement('div');
    keys.className = 'km-keys';
    const btn = document.createElement('button');
    btn.textContent = 'Shift+J';
    keys.appendChild(btn);
    document.body.replaceChildren(keys);
    return btn;
  }

  it('cancels + restores the previous binding on a click outside', () => {
    const btn = setup();
    const onResult = vi.fn();
    capture(btn, 'Shift+J', onResult);
    expect(btn.textContent).toBe('press a key…');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onResult).toHaveBeenCalledWith(null);
    expect(btn.textContent).toBe('Shift+J'); // not lost
  });

  it('does not cancel on a pointerdown on the button itself', () => {
    const btn = setup();
    const onResult = vi.fn();
    capture(btn, 'Shift+J', onResult);
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onResult).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('press a key…');
  });

  it('cancels on Escape', () => {
    const btn = setup();
    const onResult = vi.fn();
    capture(btn, 'Shift+J', onResult);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    expect(onResult).toHaveBeenCalledWith(null);
    expect(btn.textContent).toBe('Shift+J');
  });

  it('does not stack a second prompt on the same button', () => {
    const btn = setup();
    capture(btn, 'Shift+J', vi.fn());
    capture(btn, 'Shift+J', vi.fn()); // guarded no-op
    expect(document.querySelectorAll('.km-capture-hint').length).toBe(1);
  });
});

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
