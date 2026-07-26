/**
 * The page-keydown PREAMBLE — the guards that decide whether a key is
 * BranchKit's to route at all, ahead of `keyHandler.handleKeyDown`.
 *
 * It lives here rather than inline in content.ts's document listener for one
 * reason: the listener is the real key path, and until this was a module
 * nothing could execute that path but the browser. Every escape/mode test
 * called `runEscapeCascade` or `handleKeyDown` directly — around the preamble,
 * not through it — and the preamble is exactly where the key's order diverged
 * from the spoken one (a committed find used to be peeled HERE, ahead of the
 * cascade that declares the order). The tests now dispatch a real KeyboardEvent
 * through this function and the handler behind it; see escape-key-path.test.ts.
 *
 * Order is load-bearing and is the listener's, unchanged:
 *   1. composition artifacts are not keystrokes;
 *   2. while the find bar HAS THE KEYBOARD, the bar owns it;
 *   3. post-commit find navigation (n / N) beats codeword filtering.
 *
 * Not here: the focus-input cycler, the Ctrl+Alt+A snapshot chord and the
 * scroll-key held-tracking. Those sit between this and `handleKeyDown` in the
 * listener, and none of them touches Escape or a mode layer.
 */
import { keyHandler } from '../core/singletons';
import { isFindBarFocused, handleFindNavKey } from '../scan/find';

/**
 * True when the event is NOT BranchKit's to route — the caller returns without
 * preventDefault, so the key carries on to the page (and to the find bar's own
 * listener, which is a target-phase listener on the input and therefore runs
 * after this).
 */
export function preemptsPageKeys(e: KeyboardEvent): boolean {
  // Not a keystroke: keyCode 229 is the platform's text-commit sentinel (IME,
  // and any OS-level injection such as voice dictation). Its `key` is an
  // artifact — BranchKit's dictation sink surfaces as `key: "s"` whatever was
  // said — so letting it reach the hint filter or a binding acts on a keystroke
  // the user never made. The committed text follows as an input event.
  if (e.keyCode === 229 || e.isComposing) return true;

  // While the find bar HOLDS FOCUS it owns the keyboard — its focused input
  // handles typing and its own keydown handles Enter/Escape. Returning here
  // (without preventDefault) lets the keystroke reach that input and keeps the
  // hint key handler from treating letters as codeword filtering.
  //
  // The predicate is FOCUS, not presence. Gating on presence meant that a bar
  // which had lost the keyboard still swallowed every BranchKit key — click the
  // page with the bar open and hint mode, find navigation, the focus-input
  // cycler, the Ctrl+Alt+A snapshot and Escape itself all died, with no visible
  // cause and no key that could recover it. A box that no longer has the
  // keyboard has no claim on it. The other half of that fix is in find.ts: the
  // bar closes when focus leaves it inside the page, so the present-but-unfocused
  // state is transient rather than a state you can park in.
  if (isFindBarFocused()) return true;

  // After Enter commits the search the bar closes but highlights persist; n /
  // Shift+n cycle matches. This runs before the hint key handler so bare n isn't
  // swallowed as codeword input in always-mode. EXCEPT in caret/visual mode,
  // which owns n/N to extend the selection to matches (findExtend) — let those
  // keys fall through to the caret handler.
  //
  // Escape deliberately does NOT come through here: it belongs to the escape
  // cascade like every other layer, and handling it here peeled find AHEAD of
  // hint mode, which is the opposite of what the declared order says and of
  // what the spoken "over" did.
  const mode = keyHandler.getMode();
  if (mode !== 'caret' && mode !== 'visual' && handleFindNavKey(e)) return true;

  return false;
}
