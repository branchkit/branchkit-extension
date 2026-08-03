/**
 * BranchKit Browser — Keyboard handler.
 *
 * Modes: normal, insert, hint.
 * In hint mode, typed characters filter badges by word prefix.
 * Insert mode detection from DESIGN doc section 7.
 */

import { ActionDispatcher, CommandRegistry } from '../dispatcher';
import { comboFromEvent, serializeCombo } from './key-combo';
import { modes } from '../core/modes';

import { isMarkChar, isPrevPositionRegister } from '../marks';

// 'mark-set'/'mark-jump' are transient one-shot states (the next key names the
// mark), surfaced only so the mode chip can prompt "press a letter". They don't
// change key ROUTING — the arm is handled at the top of handleKeyDown.
// 'caret'/'visual' are the caret/visual-mode capture states; while active, all
// bare keys route to the injected caret handler (see setCaretKeyHandler).
// 'video' is the media-control layer (notes/DESIGN_VIDEO_MEDIA_COMMANDS.md);
// bare keys route to the injected video handler (see setVideoKeyHandler).
export type KeyMode = 'normal' | 'insert' | 'hint' | 'mark-set' | 'mark-jump' | 'caret' | 'visual' | 'video';

/** Which mark operation the next key completes. */
export type MarkArm = 'set' | 'jump';

/** Check if user is focused on an editable field. */
function isInsertMode(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Allow interception for non-text inputs
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'range'].includes(type)) return false;
    return true;
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.getAttribute('role') === 'textbox') return true;
  return false;
}

/** What a keyboard-resolved badge does instead of a plain click. Deliberately
 *  NOT exported: every arm site passes a literal, and the union is checked at
 *  those call sites. An export would invite a second module to hold one. */
type HintAction =
  'activate' | 'newtab' | 'background' | 'yank' | 'hover' | 'focus' | 'copytext' | 'caret';

export class KeyHandler {
  private sequence: string = '';
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private filterText: string = '';
  // Set when a capital letter is typed mid-codeword — the "aA" affordance:
  // finishing a codeword with a capital opens the pick in a new tab. Reset
  // whenever the codeword / hint mode resets.
  private newTabArmed: boolean = false;
  // Set when the codeword's FIRST letter is a capital — the "Aa" affordance,
  // voice "stash"'s keyboard twin: the pick opens in a background tab and the
  // gather continues (badges stay, mode stays). Same reset lifecycle as
  // newTabArmed. Both armed ("ArcH") → the first-letter commitment wins.
  private backgroundArmed: boolean = false;
  // What the NEXT badge resolved by keyboard should DO instead of a plain
  // click, armed by a verb command (yf/gf/yc/gh/gv) before or during hint
  // mode. The third field of this same hint-mode state machine, next to
  // `filterText` and `newTabArmed` — it lived in content.ts only because the
  // verb commands register there. See notes/DESIGN_HINT_ACTION_MODES.md.
  private pendingHintAction: HintAction = 'activate';
  private registry: CommandRegistry;
  private dispatcher: ActionDispatcher;
  private onFilterChange: ((prefix: string) => void) | null = null;
  // Notified whenever the mode changes (normal ↔ hint), so the mode indicator
  // chip can reflect it. Set by content.ts.
  private onModeChange: ((mode: KeyMode) => void) | null = null;
  // The last mode the chip was told about — seeded 'normal', the keyboard's
  // (and the chip's) starting state, so a defensive exit from Normal is no
  // edge. Notifications fire on the EDGE of getMode()'s answer, not on the
  // caller's guess about whether it changed — the C3 regression this
  // replaces: the cascade pops the stack and then runs the mode's exit as a
  // finisher, whose own pop no-ops, and a notification gated behind that pop
  // never fired, leaving the chip lying ("video" after Escape had already
  // peeled it).
  private lastNotifiedMode: KeyMode = 'normal';
  // Fired when the user presses Escape (no typed prefix) to leave hint mode.
  // Content decides whether to also hide the badges: manual visibility
  // dismisses them, always-visible keeps them. Set by content.ts.
  private onHintEscape: (() => void) | null = null;
  // Escape peel for a modeless layer (range-pick chips); see setEscapeHook.
  private onEscape: (() => string) | null = null;
  // Whether at least one codeword starts with a given prefix. Used to reject a
  // codeword keystroke that matches nothing — otherwise the filter hides every
  // badge until Escape. Set by content.ts; null means accept any char.
  private matchPredicate: ((prefix: string) => boolean) | null = null;
  // A keystroke the matchPredicate refused. Reported, not acted on: WHAT a
  // refusal looks like is content's to decide, the same way it decides what a
  // mode change looks like. Set by content.ts; null means report nowhere.
  private onRefusedKey: (() => void) | null = null;
  // Explicit "pass keys to the page" state (Vimium's insert mode): every key
  // reaches the page until Escape. Distinct from the automatic field-focus
  // insert (`isInsertMode`) so it works anywhere, e.g. sites with their own
  // bare-key shortcuts (Gmail, GitHub, games). See notes/DESIGN_PASS_THROUGH.md.
  private forcedInsert = false;
  // Persistent per-site form of the above — keybinds off on this host, managed
  // from the popup. Both hand every key to the page.
  private excluded = false;
  // One-shot: hand exactly the next keystroke to the page (Vimium passNextKey).
  private passNextArmed = false;
  // Marks (Vimium m / `): after `m` or `` ` ``, the NEXT printable key names the
  // mark. A wildcard second key can't be a registry binding, so it's an armed
  // one-shot like passNextArmed. See notes/DESIGN_MARKS_AND_CARET.md.
  private markArm: MarkArm | null = null;
  private onMark: ((op: MarkArm, letter: string, global: boolean) => void) | null = null;
  // The chip-facing caret SUB-mode (caret vs visual) — display detail only.
  // The caret LIFETIME (like hint's and video's) is the mode stack's; nothing
  // routes or gates on this field (Wave 3 C3c deleted the mode flags).
  private caretSub: 'caret' | 'visual' | null = null;
  private onCaretKey: ((e: KeyboardEvent) => boolean) | null = null;
  // Video layer (media controls on YouTube's mnemonics). A modal capture like
  // caret: bare keys route to the injected handler until Escape/q exits. See
  // notes/DESIGN_VIDEO_MEDIA_COMMANDS.md.
  private onVideoKey: ((e: KeyboardEvent) => boolean) | null = null;
  // Granular per-site pass-through: specific keys (matched against `event.key`,
  // e.g. "j", "#") reach the page while the REST of BranchKit's binds keep
  // working — for keyboard-heavy sites like Gmail. The persistent, per-key twin
  // of full `excluded`. Vimium's passKeys. See notes/DESIGN_PASS_THROUGH.md.
  private passKeys = new Set<string>();

  constructor(registry: CommandRegistry, dispatcher: ActionDispatcher) {
    this.registry = registry;
    this.dispatcher = dispatcher;
  }

  setFilterCallback(cb: (prefix: string) => void): void {
    this.onFilterChange = cb;
  }

  setModeChangeCallback(cb: (mode: KeyMode) => void): void {
    this.onModeChange = cb;
  }

  /** Tell the chip when — and only when — the displayed mode actually moved.
   *  Safe to call from any path, however defensively: the dedupe is on
   *  getMode()'s answer, which derives from the stack + transients, so a
   *  finisher running after the stack already popped still notifies. */
  private notifyMode(): void {
    const m = this.getMode();
    if (m === this.lastNotifiedMode) return;
    this.lastNotifiedMode = m;
    this.onModeChange?.(m);
  }

  setHintEscapeCallback(cb: () => void): void {
    this.onHintEscape = cb;
  }

  /** Install the shared escape cascade. Returns the layer peeled, or '' when
   *  nothing was open (the key then routes normally). */
  setEscapeHook(cb: () => string): void {
    this.onEscape = cb;
  }

  setMatchPredicate(fn: (prefix: string) => boolean): void {
    this.matchPredicate = fn;
  }

  /** Invoked when a codeword keystroke is refused (no codeword starts with it).
   *  Pairs with setMatchPredicate: the predicate says no, this reports it. */
  setRefusedKeyCallback(cb: () => void): void {
    this.onRefusedKey = cb;
  }

  /** Invoked when the user completes a mark (`m`/`` ` `` then a letter). `global`
   *  is true for a Shift-held letter (never for the `` ` ``/`'` registers). */
  setMarkCallback(cb: (op: MarkArm, letter: string, global: boolean) => void): void {
    this.onMark = cb;
  }

  /** Arm mark-set: the next printable key names a new mark. */
  armMarkSet(): void {
    this.markArm = 'set';
    this.notifyMode();
  }

  /** Arm mark-jump: the next printable key names the mark to jump to. */
  armMarkJump(): void {
    this.markArm = 'jump';
    this.notifyMode();
  }

  private clearMarkArm(): void {
    if (this.markArm == null) return;
    this.markArm = null;
    this.notifyMode();
  }

  /** Inject the caret-mode key handler (the CaretController). Called by content. */
  setCaretKeyHandler(fn: (e: KeyboardEvent) => boolean): void {
    this.onCaretKey = fn;
  }

  /** Enter/switch caret capture. Driven by the CaretController's onModeChange
   *  so the stack entry, the chip and the sub-mode stay in lockstep with the
   *  controller — this is the caret lifetime's one keyboard-side entry, the
   *  same shape as enterHintMode/enterVideoMode. */
  enterCaretMode(sub: 'caret' | 'visual'): void {
    this.caretSub = sub;
    modes.push('caret'); // dedupes — caret↔visual is one lifetime
    this.notifyMode();
  }

  exitCaretMode(): void {
    this.caretSub = null;
    modes.pop('caret'); // no-op when the cascade already popped it
    this.notifyMode();
  }

  /** Inject the video-layer key handler. Called by content. */
  setVideoKeyHandler(fn: (e: KeyboardEvent) => boolean): void {
    this.onVideoKey = fn;
  }

  /** Enter the video layer (the `video_mode` command, default `w`). */
  enterVideoMode(): void {
    modes.push('video'); // dedupes — one lifetime
    this.notifyMode();
  }

  exitVideoMode(): void {
    modes.pop('video'); // no-op when the cascade already popped it
    this.notifyMode();
  }

  /** True while an explicit modal capture owns the keyboard (hint, caret/
   *  visual or video — read off the stack): the field-yield / pass-through /
   *  passKeys short-circuits are suspended so the mode fully owns bare keys. */
  private isModalCapture(): boolean {
    return modes.has('hint') || modes.has('caret') || modes.has('video');
  }

  /** Which single mode the chip should name. Derived from the mode stack —
   *  the precedence ladder over private flags is gone (Wave 3 C3c); only the
   *  keyboard transients (mark arm, forced insert / exclusion) and the caret
   *  display sub-mode are the keyboard's own. */
  getMode(): KeyMode {
    if (this.markArm === 'set') return 'mark-set';
    if (this.markArm === 'jump') return 'mark-jump';
    if (modes.has('caret')) return this.caretSub ?? 'caret';
    if (modes.has('video')) return 'video';
    if (modes.has('hint')) return 'hint';
    return (this.forcedInsert || this.excluded) ? 'insert' : 'normal';
  }

  /**
   * The modal flags, UNRANKED — is this layer up, regardless of what else is.
   *
   * `getMode()` answers a different question: which single mode the chip should
   * name, resolved through a precedence chain. That chain is wrong for anyone
   * asking whether a specific layer is live, because the modes are not mutually
   * exclusive — hint mode with caret also active reports 'caret', so a caller
   * testing `getMode() === 'hint'` sees "no" while the hint layer is up and
   * still holding its codewords. Two callers need the honest answer: the escape
   * cascade, which must peel a layer that is live whether or not it is the
   * top-ranked one, and the pick window's entry-state snapshot, which restored
   * to normal instead of hint for exactly this reason.
   *
   * The ranking question does not get answered here — it gets removed by the
   * mode stack (notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md), where a mode
   * has one lifetime and a real stack position. These are the honest reads to
   * carry until then.
   */
  isHintMode(): boolean {
    return modes.has('hint');
  }

  isVideoMode(): boolean {
    return modes.has('video');
  }

  /** Enter explicit pass-through (insert) mode — every key reaches the page
   *  until Escape. Idempotent. */
  enterInsertMode(): void {
    if (this.forcedInsert) return;
    this.forcedInsert = true;
    this.notifyMode();
  }

  /** Leave explicit pass-through mode. */
  /** True in explicit pass-through ("pass all" / the i bind) — NOT per-site
   *  exclusion or field-focus insert. The escape cascade's epilogue reads
   *  this: forced insert is voice-enterable, so spoken "escape" must exit it. */
  isForcedInsert(): boolean {
    return this.forcedInsert;
  }

  exitInsertMode(): void {
    if (!this.forcedInsert) return;
    this.forcedInsert = false;
    this.notifyMode();
  }

  /** Toggle explicit pass-through mode. */
  toggleInsertMode(): void {
    if (this.forcedInsert) this.exitInsertMode();
    else this.enterInsertMode();
  }

  /** Arm a one-shot: the next keystroke is handed to the page, then normal
   *  handling resumes (Vimium passNextKey). */
  armPassNextKey(): void {
    this.passNextArmed = true;
  }

  /** Per-site exclusion: when set, keybinds are off and every key reaches the
   *  page (toggled from the popup for the current host). */
  setExcluded(v: boolean): void {
    if (this.excluded === v) return;
    this.excluded = v;
    this.notifyMode();
  }

  isExcluded(): boolean {
    return this.excluded;
  }

  /** Set the granular per-site pass-through keys (matched against `event.key`).
   *  Empty = none. */
  setPassKeys(keys: readonly string[]): void {
    this.passKeys = new Set(keys);
  }

  enterHintMode(): void {
    this.filterText = '';
    this.newTabArmed = false;
    this.backgroundArmed = false;
    modes.push('hint'); // dedupes itself — re-entry joins the one lifetime
    this.notifyMode();
  }

  exitHintMode(): void {
    this.filterText = '';
    this.sequence = '';
    this.newTabArmed = false;
    this.backgroundArmed = false;
    modes.pop('hint'); // no-op when the cascade already popped it
    this.notifyMode();
  }

  /** True when a capital was typed mid-codeword — the current pick should open
   *  in a new tab. */
  isNewTabArmed(): boolean {
    return this.newTabArmed;
  }

  /** True when the codeword's first letter was a capital — the current pick
   *  should open in a background tab and the gather continue. */
  isBackgroundArmed(): boolean {
    return this.backgroundArmed;
  }

  // --- The pending hint action ---

  /** Arm a verb for the next keyboard-resolved badge (yank, hover, …). */
  armHintAction(a: HintAction): void {
    this.pendingHintAction = a;
  }

  /**
   * Consume the armed verb and disarm in the same breath, so no path can leak
   * it to the next activation. Every activation goes through here — a verb is
   * one-shot by construction, not by each caller remembering to clear it.
   */
  takeHintAction(): HintAction {
    const a = this.pendingHintAction;
    this.pendingHintAction = 'activate';
    return a;
  }

  /**
   * Disarm without acting. An abandoned verb (`yf`, then Escape, or the hint
   * filter cleared out from under it) must not leak into the next hint.
   */
  resetHintAction(): void {
    this.pendingHintAction = 'activate';
  }

  /**
   * The casing affordances: a capital mid-codeword ("aA") opens the pick in a
   * new tab; a capital FIRST letter ("Aa") opens it in a background tab and
   * keeps the gather going — UNLESS an explicit verb is already armed, which
   * keeps precedence (`yf` then a capital still yanks). Both armed ("ArcH"):
   * the first-letter commitment wins.
   */
  promoteArmedDisposition(): void {
    if (this.pendingHintAction !== 'activate') return;
    if (this.backgroundArmed) this.pendingHintAction = 'background';
    else if (this.newTabArmed) this.pendingHintAction = 'newtab';
  }

  handleKeyDown(e: KeyboardEvent): boolean {
    // passNextKey: hand exactly the next keystroke to the page, then resume.
    if (this.passNextArmed) {
      this.passNextArmed = false;
      this.notifyMode();
      return false;
    }

    // The escape cascade — the SAME one the spoken "escape"/"over" runs, so the
    // two inputs can't drift (activate/escape-cascade.ts owns the layer order).
    // Runs before every route because a layer can be up in ANY mode. Consumes
    // the key only when it actually peeled something, so plain Escape still
    // reaches the page the rest of the time.
    //
    // Deliberately ahead of the modal-capture routes: caret is a LAYER, and
    // letting the cascade own it is what keeps the order in one place. The
    // mark arm below is a keyboard-only transient, not a layer — voice cannot
    // be in it — so it stays here. Forced insert used to sit with it on the
    // same reasoning, but "pass all" made it voice-enterable: its exit now
    // lives in the cascade's EPILOGUE (after the stack is empty — the same
    // layers-first order the old dedicated branch produced), so both escapes
    // unwind through one rule.
    if (e.key === 'Escape' && this.onEscape?.()) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    // Mark capture (Vimium m / `): the next printable key names the mark. Runs
    // before every other route so it captures regardless of hints/fields —
    // though `m`/`` ` `` only fire from Normal mode, so a field never has us
    // armed. Escape cancels; a bare modifier keydown (Shift before the letter)
    // is ignored so the arm survives to the actual letter.
    if (this.markArm != null) {
      if (e.key === 'Escape') {
        this.clearMarkArm();
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      if (isModifierKey(e.key)) return true; // wait for the letter
      if (isMarkChar(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const op = this.markArm;
        const letter = e.key;
        // Shift → global, except the `` ` ``/`'` previous-position registers
        // which are always local (Vimium's isGlobalMark).
        const global = e.shiftKey && !isPrevPositionRegister(letter);
        this.clearMarkArm();
        this.onMark?.(op, letter, global);
        return true;
      }
      // Any other non-printable (Tab, arrows, …) abandons the capture.
      this.clearMarkArm();
      return false;
    }

    // Explicit pass-through (insert toggle) or per-site exclusion: EVERY key
    // reaches the page — checked before the chord path so even Ctrl/Cmd combos
    // go to the site. Escape leaving forced insert happens ABOVE, in the
    // cascade's epilogue (shared with spoken "escape"); on an excluded site
    // Escape just reaches the page (exclusion is toggled from the popup).
    if (!this.isModalCapture() && (this.forcedInsert || this.excluded)) {
      return false;
    }

    // A real-modifier combo (Ctrl/Alt/Meta) is never codeword / filter / text
    // input, so route it straight to the command registry — checked BEFORE the
    // insert-mode yield so a bound chord fires even while typing in a field.
    // That's required for the palette chords (default Ctrl+K / Ctrl+T): they
    // must open even while focused in a search box. Unbound chords return
    // 'none' and fall through, so Ctrl+A / Cmd+C stay even in fields. Shift
    // alone is NOT a real modifier here — Shift+letter is a normal binding
    // token (handled below / by the registry), so the hide bind (default
    // Shift+F) correctly yields to the field and types "F" while you're in an
    // input. The dev-snapshot chord (Ctrl+Alt+A) is intercepted upstream in
    // content.ts before this runs.
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return this.handleNormalKey(e);
    }

    // Insert (focused in an editable field): NORMAL-mode keybinds must NOT
    // hijack a search box, so bare/Shift keys pass through to the field.
    // Escape is the exception — it blurs the field (Vimium behavior), so an
    // autofocused input on page load doesn't trap the keyboard: press Escape,
    // you're back in Normal mode and `f`/keybinds work. `hint` mode always
    // intercepts (it was entered explicitly).
    if (!this.isModalCapture() && isInsertMode()) {
      if (e.key === 'Escape') {
        const el = document.activeElement;
        if (el instanceof HTMLElement) el.blur();
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      return false;
    }

    // Granular per-site pass-through: these specific keys reach the page while
    // the rest of BranchKit's binds keep working (the Gmail case — pass j/k/e,
    // keep f). Normal mode only; hint typing and Ctrl/Cmd chords are unaffected
    // (chords already took the path above). See notes/DESIGN_PASS_THROUGH.md.
    if (!this.isModalCapture() && this.passKeys.has(e.key)) {
      return false;
    }

    // Modal capture routes by the STACK, newest first: the topmost bare-keys
    // entry owns the letters (a capture:'none' entry — a committed find, the
    // palette — sitting above does not take them, so the walk steps past it).
    // Caret/visual owns the Vim movement alphabet + yank (DESIGN_MARKS_AND_
    // CARET.md); video the media keys (DESIGN_VIDEO_MEDIA_COMMANDS.md); hint
    // mode the letters-filter (DESIGN_KEYBOARD_MODES.md). Real-modifier chords
    // already took the fast path above (so Ctrl+C still copies the visual
    // selection).
    //
    // A range pick is deliberately NOT a capturing entry. It used to be, on
    // the reasoning that chips exist to be typed at — but that swallowed the
    // whole Normal keymap for as long as chips were up, so j/k stopped
    // scrolling exactly when a pick's off-screen matches made scrolling
    // necessary (field, 2026-07-27). The walk steps past it and `f` reaches
    // the dispatcher like anywhere else. Chips typed at from an ALREADY-live
    // hint mode still work: the walk finds that entry underneath.
    const ids = modes.ids();
    for (let i = ids.length - 1; i >= 0; i--) {
      switch (ids[i]) {
        case 'caret': return this.onCaretKey ? this.onCaretKey(e) : false;
        case 'video': return this.onVideoKey ? this.onVideoKey(e) : false;
        case 'hint': return this.handleHintKey(e);
        default: continue; // find / palette / range_pick — capture: none
      }
    }

    // Normal mode (the default, even with hints painted): bare letters and
    // sequences are keybinds.
    return this.handleNormalKey(e);
  }

  /**
   * Peel a hint layer, if one is open. Called BY the escape cascade
   * (activate/escape-cascade.ts), which owns the order — this owns only what
   * the hint layers are and how they unwind.
   *
   * Two stages. With hint letters typed, the first Escape cancels just the
   * typed prefix — back to no-prefix — so a mistyped hint can be abandoned and
   * a different one started without hiding the (always-visible) hints or
   * leaving hint mode. Keeps the current filter sub-mode (codeword vs text).
   *
   * With no typed prefix, it leaves hint mode. Whether the badges also HIDE is
   * a visibility decision made in content via onHintEscape: manual visibility
   * dismisses the summoned hints, always-visible keeps them painted (they exist
   * for voice regardless of keyboard mode).
   */
  escapeHintLayer(): 'hint_prefix' | 'hint_mode' | null {
    if (!modes.has('hint')) return null;
    const prefix = this.peelHintPrefix();
    if (prefix) return prefix;
    this.escapeHintMode();
    return 'hint_mode';
  }

  /** The hint MODE's escape exit: leave the mode and let content decide the
   *  badge visibility half (onHintEscape). The cascade's exit effect for a
   *  popped hint entry — the prefix stage is the peelInner probe's, so this
   *  is unconditional. */
  escapeHintMode(): void {
    this.exitHintMode();
    this.onHintEscape?.();
  }

  /** Peel the typed hint prefix WITHOUT leaving hint mode — the first escape
   *  abandons the letters, not the mode. This is hint's intra-mode transient:
   *  the mode stack's peelInner probe (installed by content.ts) calls it, and
   *  escapeHintLayer above stays its other caller, so the peel has one
   *  implementation. Null when no prefix is typed (or hint mode is off). */
  peelHintPrefix(): 'hint_prefix' | null {
    if (!modes.has('hint') || this.filterText.length === 0) return null;
    this.filterText = '';
    this.newTabArmed = false;
    this.backgroundArmed = false;
    this.onFilterChange?.('');
    return 'hint_prefix';
  }

  private handleHintKey(e: KeyboardEvent): boolean {
    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (this.filterText.length > 0) {
        this.filterText = this.filterText.slice(0, -1);
        if (this.filterText.length === 0) {
          this.newTabArmed = false;
          this.backgroundArmed = false;
        }
        this.onFilterChange?.(this.filterText);
      }
      return true;
    }

    // `/` opens find-in-page (Vimium-style: a visible query bar that highlights
    // text matches and steps through them with Enter / Shift+Enter — it never
    // clicks a link). It used to enter a hint-text-filter that auto-activated a
    // unique match, a footgun with no on-screen affordance.
    if (e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      this.dispatcher.dispatch('find_open');
      return true;
    }

    // Codeword mode: single letter characters for filtering. Casing is the
    // disposition affordance, split by position: a capital FIRST letter arms
    // "open in a background tab, keep gathering" ("Aa" — voice stash's
    // keyboard twin), a capital anywhere later arms "open in a new focused
    // tab" ("aA").
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const atStart = this.filterText.length === 0;
      const next = this.filterText + e.key.toLowerCase();
      // No-op a keystroke that no codeword starts with — otherwise the filter
      // matches nothing and every hint vanishes until Escape. A stray key while
      // hints are up should do nothing, not blank the screen. (No predicate set
      // → accept any char, preserving the old behavior for tests/manual mode.)
      //
      // Refusing SILENTLY is what confused people: the letter left no trace, so
      // the next Escape — aimed at unsaying it — found no prefix and dropped
      // the mode instead, reading as "a stray key kicked me out" (field,
      // 2026-07-27). The keystroke is still swallowed, it just says so — and
      // WHAT it says is content's, through the same seam mode changes use.
      if (this.matchPredicate && !this.matchPredicate(next)) {
        this.onRefusedKey?.();
        return true;
      }
      this.filterText = next;
      if (e.shiftKey) {
        if (atStart) this.backgroundArmed = true;
        else this.newTabArmed = true;
      }
      this.onFilterChange?.(this.filterText);
      return true;
    }

    return false;
  }

  private handleNormalKey(e: KeyboardEvent): boolean {
    const key = keyToString(e);
    // Combo tokens are space-joined into a sequence ("KeyG KeyG"), so the
    // registry can compare on token boundaries.
    this.sequence = this.sequence ? `${this.sequence} ${key}` : key;

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    const match = this.registry.match(this.sequence);

    if (match.result === 'exact' && match.entry) {
      e.preventDefault();
      e.stopPropagation();
      this.dispatcher.dispatch(match.entry.action, match.entry.params || {});
      this.sequence = '';
      return true;
    }

    if (match.result === 'partial') {
      e.preventDefault();
      e.stopPropagation();
      this.timeout = setTimeout(() => {
        this.sequence = '';
      }, 500);
      return true;
    }

    // No match
    this.sequence = '';
    return false;
  }
}

// Canonical combo token for a keypress (layout-independent, via event.code):
// "KeyJ", "shift+KeyG", "ctrl+KeyF", "Slash". This is the token the registry's
// bindings are written in, so a key event and a binding compare directly.
function keyToString(e: KeyboardEvent): string {
  return serializeCombo(comboFromEvent(e));
}

// A modifier-only keydown (the Shift held before a global mark's letter, etc.).
// Ignored during mark capture so the arm survives to the real key.
function isModifierKey(key: string): boolean {
  return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
}
