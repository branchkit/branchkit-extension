/**
 * BranchKit Browser — the media and video-layer dispatcher bindings.
 *
 * Seven registrations lifted out of content.ts
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3b). See
 * notes/DESIGN_VIDEO_MEDIA_COMMANDS.md for the feature.
 *
 * Element-API transport verbs — no-ops in a frame with no large video, so a
 * tab-wide voice broadcast acts only in the frame that has one (embeds work
 * for free). The video layer routes bare keys to the same verbs via the
 * keyboard's injected handler.
 *
 * ## Why this is not part of `media.ts`
 *
 * `core/singletons` imports `media.ts` for `resolveVideoModeKey`. Registering
 * commands there would mean `media.ts` importing `core/singletons` back for
 * the dispatcher, which is a genuine import cycle — not merely a layering
 * preference as with `scroll-commands.ts`, but the boot hazard lint F exists
 * to reject. The mechanism stays below the singletons; the binding sits above
 * them, here.
 */

import { dispatcher, keyHandler } from '../core/singletons';
import {
  mediaPlayPause, mediaMute, mediaSpeed, mediaSeek, mediaRestart,
  type PlayPauseOp, type MuteOp, type SpeedOp, type SeekDirection,
} from './media';

export function registerMediaCommands(): void {
  dispatcher.register('video_mode', () => keyHandler.enterVideoMode());
  // The plugin's mode-mirror forwarder (external tag clear).
  dispatcher.register('video_exit', () => keyHandler.exitVideoMode());

  dispatcher.register('media_play_pause', (p) => {
    mediaPlayPause((p.op as PlayPauseOp) || 'toggle');
  });
  dispatcher.register('media_mute', (p) => {
    mediaMute((p.op as MuteOp) || 'toggle');
  });
  dispatcher.register('media_speed', (p) => {
    mediaSpeed((p.op as SpeedOp) || 'faster');
  });
  dispatcher.register('media_seek', (p) => {
    const direction: SeekDirection = p.direction === 'back' ? 'back' : 'ahead';
    mediaSeek(direction, parseInt(p.seconds || '10', 10));
  });
  dispatcher.register('media_restart', () => mediaRestart());
}
