# Video Media Commands — playing-state accessibility

**Status:** Accepted 2026-07-18 (direction + all open decisions resolved with
user). v1 LANDED 2026-07-18/19: media commands + `w` layer, Firefox-scoped
gate, voiceContext `'video'` presence gating, spoken "video" discovery mode
(exclusive tag, snap-shaped), Discovery HUD fixes (deterministic item order
actuator-side; bare-word mode rows). NEXT ARC: background media control
(accepted 2026-07-19, see that section) — phase 1 unbuilt.

## Motivation

The video-overlay gate (`render/video-overlay.ts`, 2b0ed77) suppresses badge
painting for targets mostly inside an actively-playing large video — the
measured Firefox Shorts-freeze amplifier. Codewords stay voice-matchable
(`wantsStrict` carries no overVideo cut), but that is hollow in practice: a
codeword you cannot see is a codeword you cannot say.

The resulting accessibility hole is the **bootstrap**: a mouse-free user has
no way to pause a playing video.

- The click-to-pause overlay sits 100% on the video, so its badge is gated.
- YouTube's own `k`/`j`/`l`/`m`/`f`/`c`/`i`/`<`/`>`/`Shift+N` shortcuts are
  ALL shadowed by our Normal-mode keymap (both maps descend from the same
  bare-letter vim tradition; the collision is total, not bad luck).
- Once paused everything works — the gate lifts on `v.paused`, sites pin
  their control bars, badges paint, and settings/speed/quality menus are
  ordinary hint targets.

Note the gap partly predates the gate: sites that auto-hide controls during
playback (YouTube's opacity fade) already dropped those targets from paint
and `_strict` via the cssHidden cut. Mouse users resurrect them by hovering;
mouse-free users never could. The gate widened an existing hole; this design
closes the whole thing.

## The core move: reimplement, don't pass through

Media transport is one of the few places the web platform gives us a
standardized, site-agnostic API: the HTML5 `<video>` element. Driving it
directly — `.pause()`, `.playbackRate`, `.muted`, `.currentTime` — means:

- one generic implementation, zero per-site adapters (YouTube, TikTok,
  Rumble, Vimeo, Twitch all sit on `<video>`);
- works while site controls are auto-hidden, and on sites whose UI never
  exposes the control at all (speed on TikTok);
- paints nothing over the video surface, which is the whole point of the
  overlay gate;
- keybind collisions with site shortcuts become irrelevant — we never need
  the site's `k` to work, because ours does the same thing.

Site-specific chrome (quality menus, theater mode, next-short, chapters)
stays with the existing machinery: hints once paused, and the pass-through
layer (`DESIGN_PASS_THROUGH.md`: `insert_mode`, `pass_next_key`, per-site
`passKeys` rules) for the long tail. The hint system IS the universal
per-site adapter; we do not build a second one.

## Command set (v1)

One executor module (`src/media.ts` or similar), commands in the catalog
like everything else. Target selection: the largest actively-playing video
(reuse `playingVideoRects()` — the same predicate that suppresses badges
names the video the commands drive); if none is playing, the largest video
present (so `play` works on a paused one).

| Command | Voice | Video-layer key | Implementation |
|---|---|---|---|
| `media_play_pause` | `pause` / `play` (directed via enum param) | `k`, `Space` | `.pause()` / `.play()` |
| `media_mute` | `mute` / `unmute` | `m` | `.muted` toggle |
| `media_speed` | `faster` / `slower` / `normal speed` | `>` / `<` | `.playbackRate` ± 0.25, clamp [0.25, 3], reset 1 |
| `media_seek` | `skip ahead` / `skip back` (+ `{number}` seconds variants) | `l` / `j` (10s), `→` / `←` (5s) | `.currentTime` ± n |
| `media_restart` | `restart video` | `0` | `.currentTime = 0` |

Voice-phrase constraints checked against the live catalog: bare `mute`,
`pause`, `play`, `faster`, `slower` are all unclaimed (`mute tab` is the tab
command). Seek phrases must avoid bare `back`/`next`/`previous` (history and
find own those) — hence `skip ahead`/`skip back`. Run `just voice-regress`
before merge (new words near existing ones acoustically).

Deferred, with reasons:

- **Fullscreen** — the one command that isn't a clean deterministic
  element-API call: `video.requestFullscreen()` fullscreens the bare
  element with browser chrome, not the site's player UI, so a useful
  version needs a "nearest player container" heuristic — a guess that
  reads as a bug when wrong. v1 keeps the works-or-clearly-no-ops
  property. Workaround: `pause` pins the controls; the site's fullscreen
  button is an ordinary hint target. Ship in v2 once the container
  heuristic is validated against the top few players.
- **Captions** — `video.textTracks` is the standard API but YouTube renders
  captions through its own DOM, not the track layer; best-effort at most.
  Reachable via hints when paused. Revisit on demand.
- **Next/previous video** — no element API; genuinely site chrome. Hints,
  `pass_next_key`, or the per-site `passKeys` rule cover it.
- **Volume up/down** (`↑`/`↓` in the layer only, no voice) — maybe; `mute`
  plus system volume covers most of the need.

### Caveats

- `.play()` returns a promise and can reject under autoplay policy (a
  content-script dispatch carries no user activation). In practice a video
  the user already started grants the site playback permission, but on
  rejection fall back to a synthetic click on the video element (the
  click-to-toggle convention YouTube/TikTok follow), and log it.

## Voice: global words, context-gated

Voice needs no mode — the words collide with nothing. But gate their
*eligibility* on a video being present, extending the existing
`voiceContext: 'palette' | 'caret'` mechanism with `'video'`:

- The extension already computes video presence (`playingVideoRects()`;
  widen to "any large video" for this signal). Report it as a boolean on the
  existing tab-state sync to the plugin.
- The plugin sets a **non-exclusive** tag while true (augment, not replace —
  unlike the palette's exclusive tag; browsing commands must stay live).
- Grammar cost: nil. These are static words, added once to the union at
  manifest load; eligibility is a Layer-2 tag flip, never an HLG recompile.

Payoff beyond mishear-hygiene: the Discovery HUD lists eligible commands, so
during a voice hold on a video page the media words surface automatically —
context-sensitive discoverability with no new UI (see below).

## Keyboard: the video layer

Since every YouTube key is shadowed globally, honor "base the bindings on
YouTube's" inside a mode: a **video layer** (sibling of hint mode / caret
mode, `DESIGN_KEYBOARD_MODES.md`) where YouTube's own mnemonics — the de
facto industry standard, shared by Netflix/Vimeo/Twitch — map to OUR
element-API commands. Muscle memory transfers to every site.

- Entry: `w` ("watch") — currently unbound; a bare letter is warranted
  because media control is reactive and frequent (blaring audio should not
  need a chord). Exit: `Escape` or `q`.
- Bindings per the table above; keys not in the table fall through to
  Normal handling or the page? No — a layer, like hint mode, consumes its
  alphabet; unbound keys no-op. Keep it small.
- The existing mode chip (`render/mode-chip.ts`) shows the layer is active,
  listing its keys the way hint mode's chip does.
- Standalone-extension value: the layer works with no BranchKit host at all
  (`DESIGN_EXTENSION_INDEPENDENCE.md`), same as the rest of the keymap.

## Firefox-scoped overlay gate

The gate exists solely for Firefox's WebRender compositor-surface race
(bugzilla 1989948; the manual-mode residue confound was Firefox too). On
Chrome it is pure cost. Change the default from ON to ON-iff-Firefox
(runtime UA check at the `content.ts` boot read), keeping the
`bkVideoOverlayGate` storage flag as an override in BOTH directions
(force-on for testing, force-off on Firefox at own risk). Chrome gets video
badges back immediately, shrinking the surface the media commands must
carry. Independent of everything else here; can land first.

## Discoverability

The media words are not hints — nothing on screen spells them out. Layered
answer, cheapest first:

1. **Guessable vocabulary is the primary mechanism.** `pause`, `mute`,
   `faster` are what a person says at a TV. A command you can guess needs no
   discovery surface. This is a design constraint on the word choices, not
   an afterthought — prefer the obvious word over the clever one.
2. **The `?` help overlay — free.** `help-overlay.ts` already renders each
   catalog command's keys and voice phrases (voice gated on connection).
   Catalog entries with `voice` and layer keys appear automatically; they
   should get a Media group. The overlay is itself voice-reachable
   (`help`).
3. **Discovery HUD — free once the `'video'` context tag exists.** During a
   voice hold on a video page, the eligible-set HUD shows the media words.
   This is `DESIGN_COMMAND_DISCOVERABILITY.md`'s approach B arriving for
   this command family without the platform-wide enumeration work (the
   catalog-contribution refactor already moved voice phrases into the
   extension's catalog, so that note's data-boundary table is partly
   stale).
4. **Teach-at-suppression chip (optional, v2).** The moment the overlay
   gate first hides badges is exactly when a user wonders where the hints
   went. A small one-time (rate-limited, dismissible) chip in a screen
   corner — NEVER over the video rect (the WebRender race) — reading e.g.
   `video: say "pause" · "faster" · ? for all`. Reuses the mode-chip
   surface. Ship only if 1–3 prove insufficient; teach-moments that fire
   repeatedly are noise.

## Also in this pass

- **`pass_next_key` default bind.** The one-shot pass-through exists in the
  catalog but ships unbound — undiscoverable in the exact "site has its own
  shortcut" moment it exists for. Candidate: `Backslash` (unbound, vim-ish
  "literal next" connotation). Gets it into the `?` overlay's Navigation
  group with a real key next to it.

## Non-goals

- **Per-site keybind/adapter tables** — the element API + hints + pass-
  through cover the matrix; site tables rot.
- **Edge-displaced badges** over/near playing video — retired 2026-06 for
  re-derivation stickiness; the gate header says do not re-raise; still
  true here.
- **Auto-passthrough while the player has focus** — YouTube grabs player
  focus aggressively; this would silently disable the whole keymap on watch
  pages.
- **Synthesizing site shortcuts** (sending `k` to YouTube) — fragile and
  redundant given the element API.

## Resolved decisions (2026-07-18, with user)

1. **Layer entry key: `w`** ("watch"), and `w` again exits — the entry key
   is a toggle (user feedback 2026-07-18); `Escape`/`q` also exit. Unbound
   today, single keystroke for a reactive activity, real mnemonic.
2. **`Space` in the layer: yes.** Space-toggles-playback is the most
   universal player convention; the Space-is-page-scroll objection doesn't
   apply inside an explicitly-entered layer, and Normal mode is untouched
   (Space stays unbound there, passing to the page).
3. **Seek increments: YouTube's, unchanged.** `j`/`l` = 10s, arrows = 5s,
   spoken default 10s with `{number}` override. Billion-user muscle memory;
   picking different numbers would fight the mnemonic-transfer argument
   that justified the YouTube layout.
4. **Fullscreen: deferred to v2** (moved to the deferred list above). Every
   v1 command either works or clearly no-ops; the container heuristic is
   the one guessable-wrong piece.

The theme: where the layer is explicit and scoped, match universal player
conventions exactly (2, 3); where behavior would be heuristic, cut it from
v1 rather than ship it fuzzy (4); spend an unbound bare letter only on
something frequent enough to deserve it (1).

## Background media control (accepted 2026-07-19; next arc)

The v1 gating is focused-tab-only and requires the browser frontmost. The
scenario it can't serve: working in an unrelated app with a video (or web
music player) playing in a background tab — "pause" from the editor. Design
agreed with user 2026-07-19.

### Phase 1 — background control works

- **Detection is borrowed, not built.** The SW listens to
  `chrome.tabs.onUpdated` for the `audible` flag (the speaker icon —
  hidden-tab-safe, throttle-proof, Chrome + Firefox) and keeps a registry:
  audible tabs with recency + titles. No content-script surveillance; the
  2s presence reporter stays visible-tabs-only.
- **One eligibility tag, union semantics.** The media commands stop
  requiring `plugin.browser.active`. They gate on a single tag meaning
  "something is controllable": held while (focused tab has a video) OR
  (any tab audible) OR (the resume memory below). When nothing qualifies,
  the words aren't hearable — this bounds the system-wide exposure that
  un-gating from app-active creates. This is the design's one philosophical
  shift (browser commands eligible while the browser isn't frontmost);
  user blessed it explicitly.
- **Routing picks the target by fixed priority:** (1) focused tab's video
  when the browser is frontmost — control what you see; (2) the single
  audible tab — else what you hear; (3) multiple audible → most recently
  became audible (starting a video over background music means the video).
  The SW resolves the target and routes the dispatch to that tab; hidden
  tabs execute fine (one-shot message handling isn't throttled; the
  element API doesn't need visibility). The audio change is its own
  confirmation.
- **Multi-playing gets explicit verbs, not just heuristics.** "pause
  everything" (and "mute everything") act on ALL audible tabs — the
  shut-up intent. Asymmetric on purpose: no "faster everything".
- **Resume memory (the five-minute hole).** Background-pause makes nothing
  audible; a naive tag drops and "play" goes deaf. The SW remembers the
  last tab it controlled and holds the tag while that tab still exists
  and keeps its media (cleared on tab close / full navigation), so
  pause → work → "play" round-trips indefinitely.
- **`<audio>` elements join the executor** — same element API; "pause"
  then covers Spotify web, SoundCloud, podcast players.

### Phase 2 — the media switchboard (user's proposal)

"video" becomes the media switchboard: the Discovery HUD lists everything
playable, each row wearing a spoken-alphabet codeword, selection locks the
target. All proven machinery — this is the command palette pattern
verbatim (rows → named-entity collection → alphabet badges → spoken
selection), and the alphabet reuse is safe for the same reason the
palette's is: video mode is exclusive, so hint commands can't collide.

- **Inventory is probed on demand, not tracked.** On mode entry the SW
  pings every tab's CS: got media? playing/paused? title? One cheap
  round-trip exactly when the answer matters — fresher than any hidden-tab
  bookkeeping (whose reporters we deliberately pause), and it catches
  paused media that was never audible. Sources compose: audible registry
  (eligibility) + SW presence map (candidates) + probe (truth at open).
- **HUD shape:** one row per tab with media — codeword, title,
  playing/paused glyph — above the verb list. With only ONE playable
  candidate, rows don't render (no ceremony for the common case).
- **Select-then-verb.** Bare verbs act on the phase-1 default target.
  Saying a codeword LOCKS the target for the rest of the mode session —
  "beam … play … faster … skip ahead 30" drives one player without
  re-selecting, which suits the repeated seek/speed verbs. Compound
  "pause {codeword}" is a natural later addition via the same capture.
  Target-lock state lives in the SW; row publish mirrors POST /palette.
- This supersedes the earlier "pause tab {browser_tabs}" idea — media
  rows beat tab words (a tab word targets a tab, not its media, and
  titles churn).

### Deferred

Native media-key command (system plugin): one synthesized play/pause media
key reaches macOS Now Playing — background browsers, Spotify-the-app,
Music.app. Maximal reach for bare play/pause, no seek/speed/targeting.
Different layer; must not gate this arc.

### Open decisions (background arc)

1. Tag naming: `video_present`'s meaning broadens to "media controllable"
   (audio too, background too) — rename (`plugin.browser.media_active`?)
   vs keep. Pre-launch, lean rename (no-legacy-debt).
2. Whether "play" with no resume memory and nothing audible should probe
   for the most recent paused media or stay ineligible (v1: ineligible).

## Future: user-authored site commands

Direction agreed 2026-07-18; NOT part of this pass. The question it
answers: "I want full voice control of YouTube specifically — how does
that fit a generic tool?"

Mechanism/content separation: the extension never ships site-specific
code, but "full YouTube control" doesn't need it. The missing primitive is
**user-authored, site-scoped voice commands** — phrase + URL pattern + an
action from a small set of generic verbs (press keys, activate a CSS-
selector target, open a URL template, invoke a catalog command with
params). The YouTube-ness lives in user data, not source.

Why it's cheap and robust:

- **A site's own keyboard shortcuts are its API.** Post-v1, nearly all
  remaining YouTube wants are one keystroke away (`t` theater, `i`
  miniplayer, `c` captions, `Shift+N` next video, chapter keys). "theater
  mode" → press `t` on `youtube.com` is data, and the same primitive gives
  full Gmail/Jira/anything control.
- **It's the voice sibling of existing per-site layers** — hint domain
  rules, keyboard rules (`passKeys`), keymap editor, command overrides.
  Voice phrases are the one quadrant without a user layer. Authoring UI
  belongs on the options page with first-class fields, not config syntax.
- **Grammar plumbing has a path**: user phrases are static union words (no
  recompile churn); per-site eligibility = the active-tab scoping design
  (`DESIGN_ACTIVE_TAB_GRAMMAR_SCOPING.md`), same shape as the `'video'`
  context gate above.
- **"Press keys" must ride the native path.** Content-script-synthesized
  KeyboardEvents are `isTrusted: false` and sites ignore them; the
  platform's keyboard plugin sends real OS-level keystrokes. Voice
  requires the host anyway, so this verb being voice-only is an inherent
  limitation, not laziness.
- **Endgame: shareable site packs.** Pure-data command sets ("YouTube
  pack") maintained by users, distributable without code review burden —
  the Talon-community / shared-Vimium-config precedent, slotting into the
  registry story. Full ecosystem coverage with zero site adapters in core.

Sequencing: after the media commands land, pressure-test the verbs as the
user's personal YouTube config before generalizing the authoring UI.

## Implementation order

1. Firefox-scope the overlay gate (independent, smallest, restores Chrome).
2. Catalog entries + media executor + dispatcher wiring + video layer +
   mode chip + `?` grouping. Full standalone value, no host changes.
3. `voiceContext: 'video'` plumbing (extension boolean → plugin non-
   exclusive tag), following the palette-context precedent. Voice + HUD
   discoverability light up.
4. `pass_next_key` default bind; optional teach chip later.

Each step is independently shippable; `just voice-regress` gates step 3's
merge.
