import { describe, it, expect } from 'vitest';
import { isQueryField, startQueryFieldReporting } from './query-field';

/** Minimal DOM stand-ins — the predicate only reads tag, type and state. */
function input(type: string, opts: { readOnly?: boolean; disabled?: boolean } = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  if (opts.readOnly) el.readOnly = true;
  if (opts.disabled) el.disabled = true;
  return el;
}

describe('isQueryField', () => {
  it('accepts the single-line text inputs a query lands in', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel']) {
      expect(isQueryField(input(type)), type).toBe(true);
    }
  });

  it('rejects the surfaces you COMPOSE in — punctuation is the point there', () => {
    expect(isQueryField(document.createElement('textarea'))).toBe(false);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(isQueryField(editable)).toBe(false);
  });

  it('rejects password — credentials are entered literally, never reshaped', () => {
    expect(isQueryField(input('password'))).toBe(false);
  });

  it('rejects non-text inputs and uneditable ones', () => {
    for (const type of ['checkbox', 'radio', 'range', 'submit', 'number', 'date', 'file']) {
      expect(isQueryField(input(type)), type).toBe(false);
    }
    expect(isQueryField(input('text', { readOnly: true }))).toBe(false);
    expect(isQueryField(input('text', { disabled: true }))).toBe(false);
  });

  it('rejects nothing-focused (focusout with no relatedTarget)', () => {
    expect(isQueryField(null)).toBe(false);
    expect(isQueryField(document.body)).toBe(false);
  });
});

describe('startQueryFieldReporting', () => {
  type Handler = (e: Event) => void;

  function harness(initial?: HTMLElement) {
    const handlers = new Map<string, Handler>();
    const sent: boolean[] = [];
    const listen = (_t: EventTarget, type: string, h: Handler) => { handlers.set(type, h); };
    if (initial) document.body.appendChild(initial), initial.focus();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: (m: { active: boolean }) => { sent.push(m.active); return Promise.resolve(); },
      },
    };
    return { handlers, sent, listen };
  }

  const focusEvent = (type: string, target: unknown, related?: unknown) =>
    ({ type, target, relatedTarget: related ?? null }) as unknown as Event;

  it('reports on entering a query field and on leaving for a non-field', () => {
    const { handlers, sent, listen } = harness();
    startQueryFieldReporting(listen);
    const field = input('search');
    handlers.get('focusin')!(focusEvent('focusin', field));
    handlers.get('focusout')!(focusEvent('focusout', field, document.body));
    expect(sent).toEqual([true, false]);
  });

  it('stays quiet moving between two query fields', () => {
    const { handlers, sent, listen } = harness();
    startQueryFieldReporting(listen);
    const a = input('text'), b = input('email');
    handlers.get('focusin')!(focusEvent('focusin', a));
    // focusout fires BEFORE focus lands, so relatedTarget — not activeElement —
    // is what says where focus is going.
    handlers.get('focusout')!(focusEvent('focusout', a, b));
    handlers.get('focusin')!(focusEvent('focusin', b));
    expect(sent).toEqual([true]);
  });

  it('reports leaving a query field for a textarea', () => {
    const { handlers, sent, listen } = harness();
    startQueryFieldReporting(listen);
    const field = input('text');
    handlers.get('focusin')!(focusEvent('focusin', field));
    handlers.get('focusout')!(focusEvent('focusout', field, document.createElement('textarea')));
    expect(sent).toEqual([true, false]);
  });

  it('says nothing when focus never touches a query field', () => {
    const { handlers, sent, listen } = harness();
    startQueryFieldReporting(listen);
    handlers.get('focusin')!(focusEvent('focusin', document.createElement('button')));
    expect(sent).toEqual([]);
  });
});

describe('re-assert on window focus', () => {
  it('re-posts after the plugin refused a background claim', () => {
    const handlers = new Map<string, (e: Event) => void>();
    const sent: boolean[] = [];
    const listen = (_t: EventTarget, type: string, h: (e: Event) => void) => { handlers.set(type, h); };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage: (m: { active: boolean }) => { sent.push(m.active); return Promise.resolve(); } },
    };
    const field = input('search');
    document.body.appendChild(field);
    field.focus();

    startQueryFieldReporting(listen);
    expect(sent).toEqual([true]); // claimed at boot — the plugin may refuse it

    // Browser comes to the foreground: the claim must be made again, because
    // the plugin dropped the first one and focus never changed.
    handlers.get('focus')!(new Event('focus'));
    expect(sent).toEqual([true, true]);
    field.remove();
  });
});
