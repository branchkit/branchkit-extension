/**
 * The Esc key's cascade, spoken. Voice "escape" (and "over" in a browser —
 * the plugin maps it to the same escape action) peels exactly one layer per
 * utterance, same order as the key: a pending range-pick disambiguation,
 * then the caret stack (find-over-selection → visual → caret, via the same
 * staged escape the key runs), then the find bar. Returns the layer peeled
 * ('' = nothing open — a no-op).
 *
 * Badge visibility is deliberately NOT in the cascade — "dismiss"/"hide"/
 * toggle own that: escape closes things, it doesn't mute badges.
 *
 * Every frame of the active tab runs this; the per-frame guards make only
 * the frame that owns the open layer act.
 */
import { isRangePickPending, cancelRangePick } from './range-disambiguation';
import { caret } from './selection-commands';
import { isFindBarOpen, closeFindMode } from '../scan/find';

export function runEscapeCascade(): string {
  if (isRangePickPending()) {
    cancelRangePick('voice_escape');
    return 'range_pick';
  }
  if (caret.isActive()) {
    caret.escape();
    return 'selection';
  }
  if (isFindBarOpen()) {
    closeFindMode();
    return 'find';
  }
  return '';
}
