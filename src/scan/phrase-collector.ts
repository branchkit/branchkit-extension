/**
 * BranchKit Browser — PhraseCollector: collect a phrase, then act.
 *
 * Two surfaces collect a phrase and act on it — the find box (scan/find.ts)
 * and the palette input (palette-page.ts) — and each grew the same input
 * semantics by hand. The duplicates diverged in ways that were bugs
 * (notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md, "Primitive 3"):
 *
 * - the keyCode-229 text-commit sentinel was declared twice, with
 *   near-identical prose citing the same field report — and the find box's
 *   own keydown handler didn't have it until Wave 1, so an IME confirmation
 *   Enter committed mid-composition;
 * - "an insert longer than one character is dictation" was written twice with
 *   different predicates (find once accepted `insertReplacementText`, which is
 *   what macOS AUTOCORRECT emits — the search auto-committed out from under a
 *   mid-edit user) and different timing constants (80 ms vs 400 ms);
 * - the palette closes on blur with a load-bearing reason (an exclusive tag
 *   left held while nothing has focus suppresses every command system-wide);
 *   the find box had no blur handler, and an unfocused bar left standing was
 *   a keyboard black hole.
 *
 * This module is the one implementation both surfaces consume (Wave 3, C5).
 * It owns:
 *
 * - **Key ownership while open.** A keydown wearing `keyCode === 229` or
 *   `isComposing` is not a keystroke: 229 is the platform's "text is being
 *   committed" sentinel (IME, and any OS-level text injection — the dictation
 *   sink's CGEvents arrive this way), and the `key` on such an event is an
 *   artifact of whatever the sink posted. Sentinel events are fully inert
 *   here: an Enter must not commit, an Escape must not close, and — the
 *   reason inertness matters and not just refusal — the sink's own sentinel
 *   keydowns, which precede every dictated insertion, must not cancel the
 *   commit those insertions schedule.
 * - **The dictation wire.** Dictation reaches the box the way it reaches any
 *   focused field: `input.type_text` → enigo `fast_text` posts one CGEvent
 *   per 20-character chunk, so one transcript arrives as one or more `input`
 *   events whose `data` carries a whole chunk. A human keyboard is one
 *   character per event, always — so the predicate is
 *   `inputType === 'insertText' && data.length > 1`, and nothing else.
 *   `insertReplacementText` is deliberately excluded: nothing on BranchKit's
 *   dictation path can emit it (`CGEventKeyboardSetUnicodeString` reaches the
 *   page as `insertText`); its real producer is the OS swapping a word the
 *   user typed, which is the opposite signal — mid-edit, not phrase-finished.
 *   Chunks of one utterance are gathered by a single one-shot gap timer,
 *   rearmed per chunk; the timer expiring IS the utterance boundary.
 * - **Replace-vs-append on a re-dictation.** The sink types at the caret, so
 *   a second utterance appends to the first and the box reads
 *   "gmailgithub" — a query that matches nothing. Both surfaces already
 *   converge on replace (find selects the text so the retry types over it;
 *   the palette rewrites the box when the newest utterance is the real
 *   query), so replace is the unified rule: a dictated insert that starts a
 *   NEW utterance while dictation still owns the box replaces the whole
 *   text. Any keyboard edit hands the box back to typing, after which
 *   dictation appends — extending what you typed is the caret semantic.
 * - **Commit, cancel, blur.** Dictation ends the query the way Enter does
 *   for typing (consumers that filter live instead of committing — the
 *   palette — turn that off with `autoCommitOnDictation: false`). A
 *   keystroke cancels a pending dictated commit: the user is still editing.
 *   Blur ends the session — the palette's load-bearing behavior, now the
 *   unified semantic. And a pending commit cannot outlive its session:
 *   closing, cancelling, or blurring drops it, and a closed session ignores
 *   every event, so a teardown-induced blur cannot re-enter the close.
 *
 * ## One timing constant, and why it is 400 ms
 *
 * The sources had two: find committed 80 ms after the last chunk; the
 * palette called inserts more than 400 ms apart different holds. Both
 * constants answer the same question — "is this burst over?" — so here they
 * are one timer with one constant, and the constant is bound by the riskier
 * of its two roles. As a commit debounce, the only cost of a larger value is
 * latency (imperceptible next to the transcription itself). As an utterance
 * boundary, the cost of a SMALLER value is corruption: a main-thread stall
 * longer than the gap splits one transcript in two, and the tail then
 * replaces the half already in the box — and 100 ms+ long tasks are routine
 * on heavy pages, so 80 ms is inside the failure zone. 400 ms is the value
 * already field-proven in the boundary role (the palette); 80 ms was only
 * ever field-proven as a debounce. The asymmetry decides it.
 *
 * ## What this deliberately does not own
 *
 * - **The DOM.** The palette lives in an extension-origin iframe behind a
 *   host relay (Firefox privilege reasons); a collector that owned its input
 *   element could not serve both surfaces. The consumer wires its real
 *   element to the event-feed methods and the `PhraseTextPort`, and supplies
 *   render, `onQueryChanged` (live feedback: highlights, or filtered rows)
 *   and `onCommit`. `handleKeydown` returns a verdict instead of calling
 *   preventDefault for the same reason — and a sentinel verdict means "do
 *   nothing at all": the composition's own default must survive.
 * - **Modes.** `FindMode` was never polymorphism — `find`, `highlight` and
 *   `extend` are three callers with three `onCommit`s, which is what they
 *   become at C5. What a commit MEANS (a result set, a phrase handed to a
 *   command, a row dispatched) is the consumer's, as is what happens after
 *   one (find's no-match phrase box stays open for a retry; the session
 *   survives a commit until the consumer closes it).
 *
 * No chrome imports, no document/window reads at module scope: importable
 * without booting anything. Sensing-freeze accounting: this UNIFIES the two
 * sources' existing timer patterns (find's one-shot commit debounce and the
 * palette's timestamp arithmetic) into one one-shot per burst — nothing new
 * beside them, and at C5 both originals retire into it.
 */

/**
 * Inserts further apart than this belong to different utterances; an
 * utterance is over this long after its last chunk. Chunks of one transcript
 * are milliseconds apart and two holds are seconds apart — three orders of
 * magnitude, so one coarse boundary serves both roles (see the header for
 * why it is the larger of the two constants it replaces).
 */
export const PHRASE_UTTERANCE_GAP_MS = 400;

/**
 * How the collector reads and rewrites the text it is collecting. The
 * consumer backs this with its real input element (`replace` should also
 * put the caret at the end, so the sink's next chunk appends there).
 */
export interface PhraseTextPort {
  read(): string;
  replace(text: string): void;
}

/** Structural subset of `InputEvent` — feed the real event or a literal. */
export interface PhraseInputEventLike {
  readonly inputType?: string;
  readonly data?: string | null;
  readonly isComposing?: boolean;
}

/** Structural subset of `KeyboardEvent` — feed the real event or a literal. */
export interface PhraseKeyEventLike {
  readonly key: string;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
}

export type PhraseCommitSource = 'enter' | 'dictation';
export type PhraseCancelReason = 'escape' | 'blur';

/**
 * What the consumer should do with the keydown it just fed in:
 * - `commit` / `cancel` — the collector consumed it; preventDefault and
 *   stopPropagation, the callback has already fired.
 * - `sentinel` — an IME/injection artifact; do NOTHING (no preventDefault:
 *   the composition's own default must survive).
 * - `pass` — not the collector's key; handle it yourself.
 */
export type PhraseKeyVerdict = 'commit' | 'cancel' | 'sentinel' | 'pass';

export interface PhraseSessionCallbacks {
  /** Live feedback after every accepted input — highlights, filtered rows. */
  onQueryChanged?(query: string): void;
  /** The phrase is finished. The session stays open until you close it —
   *  a no-match consumer keeps it alive so the next dictation replaces. */
  onCommit(query: string, source: PhraseCommitSource): void;
  /** The session ended without an answer. Fired AFTER the session closes,
   *  so teardown inside it (which may blur the input) cannot re-enter. */
  onCancel(reason: PhraseCancelReason): void;
}

/** Injectable one-shot timer, for consumers that don't own the globals.
 *  The default uses `setTimeout`/`clearTimeout`, which vitest fake timers
 *  patch — tests need no injection. */
export interface PhraseTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PhraseSessionOptions {
  /**
   * Dictation ends the query the way Enter does for typing (the find box).
   * Consumers whose live feedback IS the product — the palette filters rows
   * and the user then picks one — set false; the utterance accumulator still
   * runs, so re-dictation still replaces. Default true.
   */
  autoCommitOnDictation?: boolean;
  timers?: PhraseTimers;
}

export interface PhraseSession {
  /** Feed every `input` event from the wired element (after the DOM value
   *  has updated, which is when `input` fires). */
  handleInput(ev: PhraseInputEventLike): void;
  /** Feed every `keydown` from the wired element; act on the verdict. */
  handleKeydown(ev: PhraseKeyEventLike): PhraseKeyVerdict;
  /** Feed focus leaving the element. Ends the session (cancel, `'blur'`). */
  handleBlur(): void;
  /** Programmatically set the text (a reopened box seeded with its old
   *  query). Resets dictation ownership; fires no callbacks. */
  seed(text: string): void;
  /** The most recent dictated utterance — accumulating while a burst is
   *  open, settled after — or '' when typing owns the box. For consumers
   *  that resolve queries against it (the palette's `resolvePaletteQuery`). */
  lastDictation(): string;
  isOpen(): boolean;
  /** End the session without callbacks (the consumer already knows). Drops
   *  any pending commit; idempotent; every later event is inert. */
  close(): void;
}

/**
 * Did this insert arrive from dictation rather than the keyboard? The
 * signature is the length of a single insert: the sink posts one CGEvent
 * per 20-character chunk via `CGEventKeyboardSetUnicodeString`, so a whole
 * chunk lands in one event's `data`; typing is one character per event,
 * always. `insertReplacementText` (macOS autocorrect, spell-check accepts)
 * and `insertFromPaste` are multi-character and deliberately NOT dictation —
 * both mean the user is still editing. See the header.
 *
 * Two inputTypes carry the injected chunk, one per engine:
 * - Chromium delivers it as a plain `insertText`.
 * - Gecko routes ALL native multi-character text insertion through its
 *   composition pipeline: a one-shot compositionstart → compositionend burst
 *   whose `input` event is `insertCompositionText` fired AFTER the
 *   compositionend, so `isComposing` is false (captured from the real box,
 *   2026-07-26 — the field failure this branch fixes read the whole
 *   dictation as a keyboard edit, so the phrase box never committed on
 *   Firefox). A LIVE composition's updates — a user actually typing through
 *   an IME — arrive with `isComposing: true` and multi-character data as the
 *   candidate grows, which is why the flag and not the inputType is the
 *   discriminator: mid-composition means mid-edit, never a finished phrase.
 *   Known accepted edge: Gecko also orders a real IME COMMIT after its
 *   compositionend, so a ≥2-char IME commit on Firefox reads as dictation
 *   and auto-commits 400 ms later. That is the same "phrase finished"
 *   reading dictation gets — wrong only for a user IME-composing a longer
 *   query in several commits; revisit against a field report.
 *
 * Known edge, inherited from both sources on purpose: a transcript whose
 * length is 1 mod 20 ends in a single-character chunk, which this predicate
 * reads as a keystroke — the auto-commit is cancelled and Enter finishes the
 * phrase instead. The tempting fix (classify a lone character by whether a
 * 229 sentinel keydown preceded it) would misread an IME commit as dictation
 * and auto-commit 400 ms after every composed character, which is worse than
 * the edge it repairs. Revisit only against a field report.
 */
export function isDictatedInsert(ev: PhraseInputEventLike): boolean {
  if ((ev.data?.length ?? 0) <= 1) return false;
  if (ev.inputType === 'insertText') return true;
  return ev.inputType === 'insertCompositionText' && ev.isComposing === false;
}

/** Is this keydown the platform's text-commit sentinel rather than a
 *  keystroke? See the header — sentinel events must be fully inert. */
export function isSentinelKey(ev: PhraseKeyEventLike): boolean {
  return ev.keyCode === 229 || ev.isComposing === true;
}

/**
 * Is this keydown an OS text injection announcing itself? On Firefox a
 * CGEvent carrying a unicode string arrives as ONE keydown whose `key` IS
 * the whole string ("Album", keyCode of the first letter, no 229), followed
 * by one `insertText` input event PER CHARACTER — captured live 2026-07-26.
 * Those per-char inserts are byte-identical to typing, so no insert-shape
 * predicate can ever classify them; the multi-character `key` is the one
 * unforgeable signal (a human key's `.key` is a single character or a named
 * value like "Enter" — never free text).
 *
 * Named-key safety needs no exhaustive list: Enter/Escape are consumed
 * before this check, the 229/isComposing sentinel before that, and any
 * OTHER multi-char named key ("ArrowLeft", "Dead", media keys) fires no
 * insertText — arming on one is inert, and the very next keydown disarms.
 */
export function isInjectedTextKeydown(ev: PhraseKeyEventLike): boolean {
  return ev.key.length > 1;
}

const defaultTimers: PhraseTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function openPhraseSession(
  port: PhraseTextPort,
  callbacks: PhraseSessionCallbacks,
  options: PhraseSessionOptions = {},
): PhraseSession {
  const autoCommit = options.autoCommitOnDictation ?? true;
  const timers = options.timers ?? defaultTimers;

  let open = true;
  /** The utterance currently accumulating ('' when no burst is open). */
  let burst = '';
  /** The last COMPLETED utterance, while dictation still owns the box
   *  ('' once a keyboard edit hands the box back to typing). */
  let settled = '';
  /** The one-shot gap timer. Pending = a burst is open; firing = the
   *  utterance boundary (and, when enabled, the dictated commit). This is
   *  the single timer both sources' patterns unify into. */
  let gapTimer: unknown = null;
  /** Characters still expected from an announced injection (Gecko's
   *  keydown-then-per-char delivery — see isInjectedTextKeydown). While
   *  positive, insertText events are dictated chunks regardless of length;
   *  at zero the next keystroke is a keystroke again. Any human keydown
   *  disarms: the injection's inserts arrive with no keydowns between. */
  let injectedRemaining = 0;

  function clearGapTimer(): void {
    if (gapTimer === null) return;
    timers.clear(gapTimer);
    gapTimer = null;
  }

  /** The burst is over: it becomes the settled utterance dictation owns. */
  function settleBurst(): void {
    if (burst === '') return;
    settled = burst;
    burst = '';
  }

  function onGapExpired(): void {
    gapTimer = null;
    if (!open) return; // close() clears the timer, but belt and braces
    settleBurst();
    const query = port.read();
    if (autoCommit && query.trim() !== '') callbacks.onCommit(query, 'dictation');
  }

  /** Close FIRST, fire the callback SECOND — teardown inside the callback
   *  may blur the input, and that blur must find a session already closed.
   *  (find.ts learned this as "unhook the blur close before dropping the
   *  element"; with no DOM to unhook, ordering is the whole mechanism.) */
  function cancel(reason: PhraseCancelReason): void {
    open = false;
    clearGapTimer();
    callbacks.onCancel(reason);
  }

  return {
    handleInput(ev: PhraseInputEventLike): void {
      if (!open) return;
      const injected = injectedRemaining > 0 && ev.inputType === 'insertText';
      if (injected) injectedRemaining -= ev.data?.length ?? 0;
      if (injected || isDictatedInsert(ev)) {
        const chunk = ev.data ?? '';
        if (gapTimer !== null) {
          // Another chunk of the open utterance: extend it, push the
          // boundary out. Committing on the first chunk would tear the box
          // down mid-insert and spray the remainder at the page.
          burst += chunk;
        } else {
          // A NEW utterance. If dictation still owns the box, the sink just
          // appended this to the old query ("gmailgithub") — the re-dictation
          // is a retry, so the new utterance replaces the whole text.
          // (The announced-injection path replaces at the KEYDOWN instead —
          // before any character lands — so this branch never sees settled
          // text there.)
          if (settled !== '') port.replace(chunk);
          settled = '';
          burst = chunk;
        }
        clearGapTimer();
        gapTimer = timers.set(onGapExpired, PHRASE_UTTERANCE_GAP_MS);
      } else {
        // A keyboard edit (typed character, backspace, paste, autocorrect's
        // insertReplacementText): the user is editing, so a pending dictated
        // commit dies and typing owns the box from here. A non-insert input
        // also disarms an announced injection — its delivery is insertText
        // only, so anything else means the user got there first.
        injectedRemaining = 0;
        clearGapTimer();
        burst = '';
        settled = '';
      }
      callbacks.onQueryChanged?.(port.read());
    },

    handleKeydown(ev: PhraseKeyEventLike): PhraseKeyVerdict {
      if (!open) return 'pass';
      // Inert, not merely refused: the sink's sentinel keydowns precede its
      // insertions, so treating one as a keystroke would cancel the very
      // commit the insertion schedules.
      if (isSentinelKey(ev)) return 'sentinel';
      // A human keydown between an announcement and its inserts is
      // impossible (the injection is one uninterrupted delivery), so any
      // keydown reaching here disarms a stale expectation — including a
      // multi-char NAMED key that armed one and inserted nothing.
      injectedRemaining = 0;
      if (ev.key === 'Enter') {
        // Enter supersedes a pending dictated commit — one phrase, one
        // commit. An open burst settles here the same as at the boundary.
        clearGapTimer();
        settleBurst();
        callbacks.onCommit(port.read(), 'enter');
        return 'commit';
      }
      if (ev.key === 'Escape') {
        cancel('escape');
        return 'cancel';
      }
      if (isInjectedTextKeydown(ev)) {
        // The Gecko delivery: this keydown's `key` IS the dictated text, and
        // its per-character inserts follow with no further keydowns. Expect
        // exactly that many characters as dictated chunks. Re-dictation
        // replaces HERE — before any character lands — because the announced
        // text names the whole new utterance up front; a continuation chunk
        // (gap timer still armed) extends instead, same as the insert path.
        if (gapTimer === null && settled !== '') {
          port.replace('');
          settled = '';
        }
        injectedRemaining += ev.key.length;
        // 'pass', not 'sentinel': arming is a side effect, and the verdict
        // keeps its meaning — this is not the collector's key, and the
        // consumer must leave the default alone (it is what types the text).
        // A multi-char NAMED key ("ArrowDown") takes this branch too, on
        // purpose: it inserts nothing, so the arm is inert, and the consumer
        // still routes it normally off the same 'pass'.
      }
      return 'pass';
    },

    handleBlur(): void {
      if (!open) return;
      // A box that has stopped holding the keyboard has stopped having a
      // claim on it — and (the palette's load-bearing half) whatever the
      // consumer holds open on our behalf, an exclusive tag included, must
      // not outlive the focus that justified it.
      cancel('blur');
    },

    seed(text: string): void {
      if (!open) return;
      clearGapTimer();
      injectedRemaining = 0;
      burst = '';
      settled = '';
      port.replace(text);
    },

    lastDictation(): string {
      return burst !== '' ? burst : settled;
    },

    isOpen(): boolean {
      return open;
    },

    close(): void {
      open = false;
      clearGapTimer();
    },
  };
}
