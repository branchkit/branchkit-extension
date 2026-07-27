import { ActionDispatcher, CommandRegistry } from '../dispatcher';
import { KeyHandler } from '../activate/keyboard';
import {
  anyHolderMatchesPrefix, soleHolderMatch, resolveCodeword, narrowByPrefix,
} from '../labels/holder-registry';
import { flashToast } from '../render/toast';
import { setModeChip, flashModeChipRefusal, setKeyboardArmed } from '../render/mode-chip';
import { resolveVideoModeKey } from '../activate/media';
import { getSiteKeyState, onSiteKeysChanged } from '../keymap/keyboard-rules';

/**
 * Stable, construct-once runtime singletons, promoted out of content.ts module
 * scope (Tier 0 of notes/DESIGN_EXTENSION_RESTRUCTURE.md) so extracted
 * source/reaction modules can import them directly. Each is a const reference
 * that is never reassigned; their only lifecycle interaction is
 * disconnect-on-teardown, owned by PageSession.
 */
export const dispatcher = new ActionDispatcher();
export const registry = new CommandRegistry();
export const keyHandler = new KeyHandler(registry, dispatcher);

// --- The keyboard's codeword wiring ------------------------------------------
//
// This lived in content.ts, which meant the entry point had to know that typing
// a codeword consults the holder registry. It belongs here instead: singletons
// is the construct-once composition point, and it is already the surface every
// module pulls `keyHandler` through.
//
// It is NOT defaulted inside KeyHandler. Both hooks are null there on purpose —
// a null `matchPredicate` means "no gate, accept every key", which is what lets
// activate/keyboard.test.ts drive the handler in isolation without standing up
// a holder registry. Baking the real predicate into the field would silently
// gate every unset test against an empty registry.
//
// Both dependencies are leaves (holder-registry and toast each have zero
// relative imports), so reaching them from here introduces no cycle.

// The keyboard's accept gate asks the registry the SAME question the spoken
// path asks — who owns this codeword — instead of a store-only subset of it.
// Chips and search badges hold codewords outside the store, and a keyboard that
// only knew the store rejected their first letter as a stray key.
keyHandler.setMatchPredicate((prefix) => anyHolderMatchesPrefix(prefix));

// Mid-codeword progress and typed completion, through the ONE registry order
// (labels/holder-registry.ts). A sole match fires at the same moment speaking
// the whole codeword would — chip, search badge or link hint alike; the store's
// completion bookkeeping lives in its activate delegate. When nothing
// completes, every eligible holder narrows in the same breath ('' — the pair
// cancelled — resets them all).
keyHandler.setFilterCallback((prefix: string) => {
  const sole = soleHolderMatch(prefix);
  if (sole) {
    const outcome = resolveCodeword(sole);
    if (outcome.kind === 'off_screen') {
      flashToast('That match is off screen — scroll to it first');
      return;
    }
    if (outcome.kind === 'acted') keyHandler.exitHintMode();
    return;
  }
  narrowByPrefix(prefix);
});

// The mode chip. The keyboard reports a mode change or a refusal and does not
// know what either looks like — the chip has ONE writer and it is render/.
keyHandler.setModeChangeCallback((mode) => {
  setModeChip(mode);
  setKeyboardArmed(mode === 'hint');
});
keyHandler.setRefusedKeyCallback(() => flashModeChipRefusal());

// Video layer. The layer owns bare keys, so dispatch and consume BOTH swallow
// the key — an unbound letter no-ops instead of firing a Normal bind or
// reaching the page.
keyHandler.setVideoKeyHandler((e) => {
  const r = resolveVideoModeKey(e);
  if (r.kind === 'exit') {
    e.preventDefault();
    e.stopPropagation();
    keyHandler.exitVideoMode();
    return true;
  }
  e.preventDefault();
  e.stopPropagation();
  if (r.kind === 'dispatch') dispatcher.dispatch(r.action, r.params ?? {});
  return true;
});

// Per-site keyboard policy — full exclusion (all keys to the page) and/or
// granular passthrough (specific keys to the page, the rest of BranchKit's
// binds still work). Applied on load and kept live as the popup edits it.
// Voice is unaffected. See notes/DESIGN_PASS_THROUGH.md.
function applySiteKeys(): void {
  void getSiteKeyState(location.href).then(({ excluded, passKeys }) => {
    keyHandler.setExcluded(excluded);
    keyHandler.setPassKeys(passKeys);
  });
}
applySiteKeys();
onSiteKeysChanged(applySiteKeys);
