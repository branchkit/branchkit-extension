/**
 * PhraseCollector — the shared collect-a-phrase-then-act input semantics
 * (notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md, "Primitive 3").
 *
 * These tests drive the collector the way the REAL wire does, because the
 * find suite's first cut did not and that is precisely how a bug shipped
 * (it fabricated an `insertFromPaste` event the dictation path never emits).
 * Dictation is `input.type_text` → enigo `fast_text`: one event per
 * 20-character chunk, whole chunk in `data`, preceded by a keyCode-229
 * sentinel keydown. Typing is one character per event. Both are modelled
 * literally below, against a fake text port that appends at the caret the
 * way the OS sink does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openPhraseSession,
  isDictatedInsert,
  isSentinelKey,
  PHRASE_UTTERANCE_GAP_MS,
  type PhraseSession,
  type PhraseSessionOptions,
  type PhraseTextPort,
} from './phrase-collector';

/** The consumer's input element, reduced to its text: `sinkType` is what the
 *  OS dictation sink (and a typing human) does — insert at the caret, which
 *  for a box with the caret at the end is an append. */
function makePort(initial = '') {
  let text = initial;
  const port: PhraseTextPort & { sinkType(data: string): void } = {
    read: () => text,
    replace: (t: string) => { text = t; },
    sinkType: (data: string) => { text += data; },
  };
  return port;
}

interface Harness {
  session: PhraseSession;
  port: ReturnType<typeof makePort>;
  commits: Array<{ query: string; source: string }>;
  cancels: string[];
  queries: string[];
  /** One dictated transcript: the sink chunks at 20 chars, one event each. */
  dictate(text: string): void;
  /** A human at the keyboard: one character per event. */
  type(text: string): void;
  /** The utterance boundary passes with nothing further arriving. */
  settle(): void;
}

function makeHarness(options?: PhraseSessionOptions): Harness {
  const port = makePort();
  const commits: Array<{ query: string; source: string }> = [];
  const cancels: string[] = [];
  const queries: string[] = [];
  const session = openPhraseSession(port, {
    onQueryChanged: (q) => queries.push(q),
    onCommit: (query, source) => commits.push({ query, source }),
    onCancel: (reason) => cancels.push(reason),
  }, options);
  const dictate = (text: string): void => {
    for (let i = 0; i < text.length; i += 20) {
      const chunk = text.slice(i, i + 20);
      // The sink's CGEvent reaches the page as a sentinel keydown first,
      // then the insertion. Feeding both is the point: the sentinel must
      // not disturb what the insertion sets up.
      session.handleKeydown({ key: chunk[0], keyCode: 229 });
      port.sinkType(chunk);
      session.handleInput({ inputType: 'insertText', data: chunk });
    }
  };
  const type = (text: string): void => {
    for (const ch of text) {
      session.handleKeydown({ key: ch });
      port.sinkType(ch);
      session.handleInput({ inputType: 'insertText', data: ch });
    }
  };
  const settle = (): void => { vi.advanceTimersByTime(PHRASE_UTTERANCE_GAP_MS); };
  return { session, port, commits, cancels, queries, dictate, type, settle };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('phrase collector: dictation commits, typing waits for Enter', () => {
  it('a dictated insert commits after the utterance boundary', () => {
    const h = makeHarness();
    h.dictate('alpha');
    expect(h.commits).toHaveLength(0); // not before the boundary
    h.settle();
    expect(h.commits).toEqual([{ query: 'alpha', source: 'dictation' }]);
  });

  it('a chunked dictated phrase commits ONCE, after the last chunk', () => {
    // The failure this guards: committing on the first chunk tears the box
    // down mid-insert and sprays the remainder at the page.
    const h = makeHarness();
    const phrase = 'the quick brown fox jumps over it'; // 33 chars → 2 chunks
    h.dictate(phrase);
    expect(h.commits).toHaveLength(0); // still collecting between chunks
    h.settle();
    vi.runAllTimers();
    expect(h.commits).toEqual([{ query: phrase, source: 'dictation' }]);
  });

  it('chunks arriving inside the gap extend one utterance, not two', () => {
    const h = makeHarness();
    h.dictate('twenty characters ok'); // exactly one chunk
    vi.advanceTimersByTime(PHRASE_UTTERANCE_GAP_MS - 1);
    h.dictate(' and the tail');
    h.settle();
    expect(h.commits).toEqual([
      { query: 'twenty characters ok and the tail', source: 'dictation' },
    ]);
  });

  it('typing does not commit', () => {
    const h = makeHarness();
    h.type('alpha');
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
  });

  it('a keystroke cancels a pending dictated commit — still editing', () => {
    const h = makeHarness();
    h.dictate('alpha');
    h.type('x');
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
  });

  it('an empty dictation does not commit', () => {
    // A dictation that produced nothing must leave the box open, not commit
    // an empty query.
    const h = makeHarness();
    h.dictate('   ');
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
  });

  it('a paste is not dictation', () => {
    // A pasted phrase is often something you then edit; live feedback shows
    // while you decide, and Enter commits it.
    const h = makeHarness();
    h.port.sinkType('pasted phrase');
    h.session.handleInput({ inputType: 'insertFromPaste', data: 'pasted phrase' });
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
  });

  it('autoCommitOnDictation: false collects but never commits (the palette)', () => {
    const h = makeHarness({ autoCommitOnDictation: false });
    h.dictate('github');
    h.settle();
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
    expect(h.session.lastDictation()).toBe('github'); // the accumulator still ran
  });
});

describe('phrase collector: Enter and Escape', () => {
  it('Enter commits, with the commit verdict', () => {
    const h = makeHarness();
    h.type('alpha');
    expect(h.session.handleKeydown({ key: 'Enter' })).toBe('commit');
    expect(h.commits).toEqual([{ query: 'alpha', source: 'enter' }]);
  });

  it('Enter mid-burst supersedes the pending dictated commit — one commit', () => {
    const h = makeHarness();
    h.dictate('alpha');
    h.session.handleKeydown({ key: 'Enter' });
    vi.runAllTimers();
    expect(h.commits).toEqual([{ query: 'alpha', source: 'enter' }]);
  });

  it('Escape cancels, drops a pending commit, and closes the session', () => {
    const h = makeHarness();
    h.dictate('alpha');
    expect(h.session.handleKeydown({ key: 'Escape' })).toBe('cancel');
    expect(h.cancels).toEqual(['escape']);
    expect(h.session.isOpen()).toBe(false);
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
  });

  it('keys the collector does not own pass through', () => {
    const h = makeHarness();
    expect(h.session.handleKeydown({ key: 'ArrowDown' })).toBe('pass');
    expect(h.session.handleKeydown({ key: 'n' })).toBe('pass');
    expect(h.cancels).toHaveLength(0);
    expect(h.commits).toHaveLength(0);
  });
});

describe('phrase collector: the 229 sentinel and isComposing are not keystrokes', () => {
  it('an Enter carrying keyCode 229 does not commit', () => {
    const h = makeHarness();
    h.type('alph');
    expect(h.session.handleKeydown({ key: 'Enter', keyCode: 229 })).toBe('sentinel');
    expect(h.commits).toHaveLength(0);
  });

  it('an IME confirmation Enter mid-composition does not commit', () => {
    const h = makeHarness();
    h.type('alph');
    expect(h.session.handleKeydown({ key: 'Enter', isComposing: true })).toBe('sentinel');
    expect(h.commits).toHaveLength(0);
  });

  it('an Escape carrying the sentinel cancels the composition, not the session', () => {
    const h = makeHarness();
    h.type('alpha');
    expect(h.session.handleKeydown({ key: 'Escape', keyCode: 229 })).toBe('sentinel');
    expect(h.session.handleKeydown({ key: 'Escape', isComposing: true })).toBe('sentinel');
    expect(h.cancels).toHaveLength(0);
    expect(h.session.isOpen()).toBe(true);
  });

  it('the sink\'s own sentinel keydowns do not cancel a pending dictated commit', () => {
    // Every dictated insertion is PRECEDED by a sentinel keydown whose `key`
    // is an artifact. Were the sentinel a keystroke, each chunk's keydown
    // would cancel the commit its insertion schedules — the reason these
    // events are inert rather than merely refused. The harness's dictate()
    // already feeds the paired sentinels; this adds a trailing one.
    const h = makeHarness();
    h.dictate('alpha');
    h.session.handleKeydown({ key: 's', keyCode: 229 });
    h.settle();
    expect(h.commits).toEqual([{ query: 'alpha', source: 'dictation' }]);
  });

  it('real events satisfy the structural types', () => {
    const h = makeHarness();
    h.port.sinkType('hello world');
    h.session.handleInput(
      new InputEvent('input', { inputType: 'insertText', data: 'hello world' }),
    );
    const verdict = h.session.handleKeydown(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229 } as KeyboardEventInit),
    );
    expect(verdict).toBe('sentinel');
    h.settle();
    expect(h.commits).toEqual([{ query: 'hello world', source: 'dictation' }]);
  });
});

describe('phrase collector: autocorrect does not commit', () => {
  it('an autocorrect-shaped insertReplacementText is not dictation and does not auto-commit', () => {
    // macOS autocorrect swaps a word with insertReplacementText — an insert
    // the user never asked for, arriving mid-typing. It used to satisfy the
    // find box's dictation predicate and commit the search out from under
    // them; the palette's predicate would still accept it today. Not here.
    const h = makeHarness();
    h.type('alpga');
    h.port.replace('alpha'); // the OS swaps the word in one go
    h.session.handleInput({ inputType: 'insertReplacementText', data: 'alpha' });
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
    expect(h.port.read()).toBe('alpha');
    expect(h.session.lastDictation()).toBe(''); // typing owns the box
  });

  it('an autocorrect after a dictated chunk cancels the pending commit', () => {
    // A replacement means the user is mid-edit, whatever came before it.
    const h = makeHarness();
    h.dictate('alpha');
    h.session.handleInput({ inputType: 'insertReplacementText', data: 'alpha' });
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
  });
});

describe('phrase collector: Gecko delivers the injected chunk as a composition', () => {
  // Firefox routes native multi-character insertion through its composition
  // pipeline: compositionstart → compositionend, then ONE input event of
  // inputType insertCompositionText with isComposing FALSE (fired after the
  // compositionend). Event sequence captured from the real phrase box on
  // Firefox, 2026-07-26 — the field regression: the whole dictation read as
  // a keyboard edit, so the box never committed and the pick chips never
  // armed ("I said album ... I see no hints").
  it('a post-composition insertCompositionText commits like any dictated insert', () => {
    const h = makeHarness();
    h.port.sinkType('Album');
    h.session.handleInput({ inputType: 'insertCompositionText', data: 'Album', isComposing: false });
    expect(h.commits).toHaveLength(0); // not before the boundary
    h.settle();
    expect(h.commits).toEqual([{ query: 'Album', source: 'dictation' }]);
  });

  it('a LIVE composition update (isComposing true) is a keyboard edit, not dictation', () => {
    // A user actually typing through an IME: the growing candidate arrives as
    // multi-character insertCompositionText updates while the composition is
    // open. Mid-composition means mid-edit — it must cancel a pending
    // dictated commit, never schedule one.
    const h = makeHarness();
    h.dictate('alpha');
    h.port.replace('かん');
    h.session.handleInput({ inputType: 'insertCompositionText', data: 'かん', isComposing: true });
    h.settle();
    expect(h.commits).toHaveLength(0);
  });

  it('a single-character composition insert stays a keystroke', () => {
    const h = makeHarness();
    h.port.sinkType('a');
    h.session.handleInput({ inputType: 'insertCompositionText', data: 'a', isComposing: false });
    h.settle();
    expect(h.commits).toHaveLength(0);
  });

  it('isDictatedInsert: the discriminator is the isComposing flag, not the inputType', () => {
    expect(isDictatedInsert({ inputType: 'insertCompositionText', data: 'Album', isComposing: false })).toBe(true);
    expect(isDictatedInsert({ inputType: 'insertCompositionText', data: 'Album', isComposing: true })).toBe(false);
    // The InputEvent constructor's default (real events always carry the
    // flag; a hand-built literal that omits it must NOT read as dictation —
    // absence of evidence of a closed composition is not evidence).
    expect(isDictatedInsert({ inputType: 'insertCompositionText', data: 'Album' })).toBe(false);
    expect(isDictatedInsert({ inputType: 'insertText', data: 'Album' })).toBe(true);
  });
});

describe('phrase collector: re-dictation replaces rather than appends', () => {
  it('a second utterance replaces the first — the sink appended, the collector undoes it', () => {
    // The sink types at the caret, so "gmail" then "github" leaves
    // "gmailgithub" in the box, which matches nothing. The re-dictation is a
    // retry: the new utterance IS the query.
    const h = makeHarness({ autoCommitOnDictation: false });
    h.dictate('gmail');
    h.settle();
    h.dictate('github');
    expect(h.port.read()).toBe('github');
    expect(h.session.lastDictation()).toBe('github');
  });

  it('a re-dictation after a committed no-match retries with a fresh query', () => {
    // Find's phrase-target path: commit found nothing, the consumer kept the
    // session open, and the next dictation replaces instead of appending.
    const h = makeHarness();
    h.dictate('zzz');
    h.settle();
    expect(h.commits).toEqual([{ query: 'zzz', source: 'dictation' }]);
    h.dictate('alpha');
    h.settle();
    expect(h.port.read()).toBe('alpha');
    expect(h.commits[1]).toEqual({ query: 'alpha', source: 'dictation' });
  });

  it('a multi-chunk re-dictation replaces once, then extends', () => {
    const h = makeHarness({ autoCommitOnDictation: false });
    h.dictate('gmail');
    h.settle();
    h.dictate('the quick brown fox jumps over it'); // 2 chunks
    h.settle();
    expect(h.port.read()).toBe('the quick brown fox jumps over it');
  });

  it('after a keyboard edit, dictation appends — typing owns the box', () => {
    // Extending what you typed is the caret semantic; replace is only for
    // dictation-over-dictation.
    const h = makeHarness({ autoCommitOnDictation: false });
    h.dictate('gmail');
    h.settle();
    h.type('x');
    h.dictate(' inbox');
    expect(h.port.read()).toBe('gmailx inbox');
  });

  it('seed resets dictation ownership', () => {
    const h = makeHarness({ autoCommitOnDictation: false });
    h.dictate('gmail');
    h.settle();
    h.session.seed('alpha'); // a reopened box seeded with its old query
    expect(h.port.read()).toBe('alpha');
    expect(h.session.lastDictation()).toBe('');
    h.dictate(' beta');
    expect(h.port.read()).toBe('alpha beta'); // no stale replace
  });
});

describe('phrase collector: a pending commit cannot outlive its session', () => {
  it('close() drops a pending dictated commit', () => {
    const h = makeHarness();
    h.dictate('alpha');
    h.session.close();
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
    expect(h.session.isOpen()).toBe(false);
  });

  it('blur ends the session and drops a pending commit scheduled before it', () => {
    const h = makeHarness();
    h.dictate('alpha');
    h.session.handleBlur();
    expect(h.cancels).toEqual(['blur']);
    expect(h.session.isOpen()).toBe(false);
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
  });

  it('a teardown-induced blur cannot re-enter the close', () => {
    // The consumer's teardown inside onCancel may blur the real input; that
    // blur must find a session already closed. find.ts learned this as
    // "unhook the blur close before dropping the element" — here the
    // ordering (close first, fire second) is the whole mechanism.
    const port = makePort();
    const cancels: string[] = [];
    const session = openPhraseSession(port, {
      onCommit: () => {},
      onCancel: (reason) => {
        cancels.push(reason);
        session.handleBlur(); // teardown blurs the input
      },
    });
    session.handleKeydown({ key: 'Escape' });
    expect(cancels).toEqual(['escape']); // exactly one, not escape-then-blur
  });

  it('every event is inert after close', () => {
    const h = makeHarness();
    h.session.close();
    h.port.sinkType('alpha');
    h.session.handleInput({ inputType: 'insertText', data: 'alpha' });
    expect(h.session.handleKeydown({ key: 'Enter' })).toBe('pass');
    h.session.handleBlur();
    vi.runAllTimers();
    expect(h.commits).toHaveLength(0);
    expect(h.cancels).toHaveLength(0);
    expect(h.queries).toHaveLength(0);
  });

  it('close is idempotent', () => {
    const h = makeHarness();
    h.session.close();
    expect(() => h.session.close()).not.toThrow();
  });

  it('a consumer closing inside onCommit stops the session there', () => {
    const port = makePort();
    const commits: string[] = [];
    const session = openPhraseSession(port, {
      onCommit: (query) => { commits.push(query); session.close(); },
      onCancel: () => {},
    });
    port.sinkType('alpha');
    session.handleKeydown({ key: 'a', keyCode: 229 });
    session.handleInput({ inputType: 'insertText', data: 'alpha' });
    vi.advanceTimersByTime(PHRASE_UTTERANCE_GAP_MS);
    expect(commits).toEqual(['alpha']);
    expect(session.isOpen()).toBe(false);
    expect(session.handleKeydown({ key: 'Enter' })).toBe('pass'); // inert now
    expect(commits).toHaveLength(1);
  });
});

describe('phrase collector: live feedback', () => {
  it('onQueryChanged fires for every accepted input with the current text', () => {
    const h = makeHarness();
    h.type('ab');
    h.dictate('cdefghijklmnopqrstuvwx'); // 22 chars → chunks of 20 + 2
    expect(h.queries).toEqual(['a', 'ab', 'abcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuvwx']);
  });

  it('onQueryChanged reflects a re-dictation replace, not the appended garbage', () => {
    const h = makeHarness({ autoCommitOnDictation: false });
    h.dictate('gmail');
    h.settle();
    h.dictate('github');
    expect(h.queries[h.queries.length - 1]).toBe('github'); // never 'gmailgithub'
  });
});

describe('phrase collector: predicates', () => {
  it('isDictatedInsert accepts only multi-character insertText', () => {
    expect(isDictatedInsert({ inputType: 'insertText', data: 'album' })).toBe(true);
    expect(isDictatedInsert({ inputType: 'insertText', data: 'a' })).toBe(false);
    expect(isDictatedInsert({ inputType: 'insertText', data: null })).toBe(false);
    expect(isDictatedInsert({ inputType: 'insertReplacementText', data: 'album' })).toBe(false);
    expect(isDictatedInsert({ inputType: 'insertFromPaste', data: 'album' })).toBe(false);
    expect(isDictatedInsert({ inputType: 'deleteContentBackward', data: null })).toBe(false);
  });

  it('isSentinelKey recognizes 229 and open compositions', () => {
    expect(isSentinelKey({ key: 'Enter', keyCode: 229 })).toBe(true);
    expect(isSentinelKey({ key: 'Enter', isComposing: true })).toBe(true);
    expect(isSentinelKey({ key: 'Enter', keyCode: 13 })).toBe(false);
    expect(isSentinelKey({ key: 'Enter' })).toBe(false);
  });
});
