# Design: Reaching the Palette on Restricted Pages

Status: proposal, investigation 2026-08-02 (section at bottom — resolves most
of Q3/Q4, adds a store-sequencing decision). Nothing built. Field report
2026-07-30: "I open a new browser tab and the extension isn't active — I can't
get into the palette to go to one of my bookmarks."

Open a new tab and the palette is unreachable. Same on `chrome://settings`,
`chrome://extensions`, the Chrome Web Store, and the PDF viewer. The new tab page
is the one that hurts, because it is exactly where you want to jump to a bookmark.

## Why it fails

Two independent reasons, both confirmed against the built manifest:

- **No content script.** `content_scripts` matches `<all_urls>`, which
  **excludes** `chrome://` URLs — Chrome refuses injection there. Nothing of ours
  is running on the page at all.
- **No browser-level shortcut.** `commands` is absent from the manifest, so every
  keybind is a content-script `keydown` (`keymap-registry.ts`). With no content
  script there is nothing listening for `Shift+B`.

And even with a key, the palette is an iframe injected *into a page*
(`render/palette-host.ts`), and on a restricted page there is no page to inject
into.

Note this is a superset of "new tab". The same dead zone appears whenever the
content script is **orphaned** — the "Extension context invalidated" state after
an extension reload, which today leaves no palette until you reload the page.

## The enabling fact

**`palette.html` is already a standalone extension page.** Verified repeatedly on
2026-07-30 by loading `chrome-extension://<id>/palette.html?scope=…` as a
top-level tab: bootstrap, tab marks, letter mode, prefix narrowing, badges and the
mode indicator all worked, because the page fetches its privileged data over
`PALETTE_BOOTSTRAP` rather than reading `chrome.*` directly (the Firefox
iframe-privileges fallback, `palette-page.ts:138-150`, pays off here).

So the palette does not need a host page. It needs somewhere to be *shown* that
isn't a restricted page. That is the whole design space.

## Route A — own the new tab page (do this first)

`chrome_url_overrides.newtab` points Chrome's new tab at a page we serve. Being
an extension page, our keymap can run on it **directly** — no content script, no
Chrome restriction — so the existing keybinds work there unchanged.

**It must not steal focus from the omnibox.** Chrome focuses the address bar when
you open a new tab, and `Ctrl+T` then typing a URL is muscle memory you would
notice losing within a minute. This is the failure mode that makes extension new
tab pages hated, so it is a hard constraint rather than a preference:

- `Ctrl+T`, then type → omnibox, exactly as today.
- `Ctrl+T`, then `Shift+B` → bookmark palette, focused, on the page.

Nothing is taken away and no new shortcut is invented.

**The override cannot be a runtime setting.** `chrome_url_overrides` is a manifest
key, claimed at install time; no checkbox in our options page can hand the new tab
page back to Chrome. What exists instead:

- **Chrome's own revert.** Chrome prompts ("An extension changed your new tab
  page") with keep-or-revert, and the choice is revisitable in Chrome's settings.
  That is the user's off switch, and it is Chrome's, not ours.
- **Everything *inside* the page is ours to make configurable** — what it shows,
  whether it shows anything at all. An "off" setting can reduce our page to
  near-blank, which costs little in practice since the omnibox is focused anyway;
  what it cannot do is restore Chrome's own new tab content.

The user asked for an on/off toggle. This is the honest answer: the *behaviour* can
toggle, the *claim* cannot.

## Route B — a palette window reachable anywhere (later)

A `chrome.commands` shortcut is handled by the browser, not a page, so it fires on
restricted pages. Its handler shows the palette in an extension-page context.

**Do NOT use `_execute_action` / the toolbar popup.** `action.default_popup` is
already `popup.html`, the quick-settings panel (badge persistence, badge labels,
hint visibility). Chrome allows exactly one popup, and an icon click is
indistinguishable from an `_execute_action` press, so we cannot serve settings to
one and the palette to the other without losing the settings panel.

Use a normal command whose handler opens `palette.html` via
`chrome.windows.create({ type: 'popup', … })` instead. That leaves the settings
popup intact and gives full control of size and position. Cost: it is a real OS
window — it appears in the window list and will not auto-dismiss on blur the way a
toolbar popup does, so teardown is ours to handle. (The palette's existing
`window.addEventListener('blur', close)` may cover this; verify rather than
assume.)

**Command rows would silently do nothing.** `handlePaletteAction` dispatches a
command only when it has an origin tab — `action.kind === 'command' && typeof
originTabId === 'number'` (`background/palette.ts`). Opened from a window there is
no sender tab, so the command palette would appear and then quietly fail, which is
the worst failure shape available. Needs a fallback to the active tab, and that
carries a real question: active tab of *which* window, given the palette window
itself is now frontmost?

Bookmarks and tab switching need no such work. `switch_tab` carries its own tab
id, and `open_bookmark` now defaults to a new tab, which is exactly what the
no-origin-tab path already does.

**Shortcut constraints.** A `chrome.commands` binding must include Ctrl/Alt/Cmd —
it cannot be a bare `Shift+B` — so this route necessarily introduces a *second*
shortcut for the same surface. A wart, and the same one Vimium and friends carry.
Also, if the suggested key collides with a Chrome-owned shortcut, Chrome silently
declines to bind it and the user must set it at `chrome://extensions/shortcuts`;
the setup docs need to say so, because the failure is invisible.

## Why A before B

They aren't competitors, and the order costs nothing: Route A creates no work that
Route B throws away. A fixes the case actually being hit, with no extra keystroke,
no second window, and no origin-tab problem. B is the general safety net —
`chrome://settings`, the Web Store, and orphaned content scripts — and is strictly
more work, mostly because of the settings-popup collision and the command-dispatch
gap.

## Non-goals

- **An omnibox keyword** (`chrome.omnibox`, e.g. `bk work github`). Considered and
  declined: on a new tab the address bar is already focused, so it fits the case
  neatly and is cheap — but it renders in Chrome's suggestion UI, which means no
  codeword badges, no folder sections, and no letter mode. It would be a second,
  differently-shaped bookmark finder rather than the palette. Revisit only if both
  routes above prove unworkable.
- **Making the palette work inside restricted pages.** Not possible; Chrome
  forbids injection. Every route here is about hosting it elsewhere.
- **Unifying the in-page and browser-level shortcuts.** Chrome's modifier
  requirement makes it impossible.

## Open questions

1. **What does the new tab page show when it isn't hosting a palette?** You will
   look at it dozens of times a day, and it replaces Chrome's shortcut tiles. A
   deliberately plain page is the safe default — the omnibox is focused, so a blank
   page costs less than it sounds — but "plain" still needs deciding. Resolve
   before building, not during.
2. **Does the palette auto-open on a new tab?** Leaning no: auto-opening means
   auto-focusing, which breaks `Ctrl+T` + type. A visible hint plus `Shift+B` is
   the conservative shape. Worth field-testing both, cheaply, before committing.
3. **Host as an iframe, or render the palette directly?** Hosting via
   `palette-host.ts` reuses the relay and the codeword-holder plumbing; rendering
   `palette-page.ts` straight into the new tab page is simpler but bypasses the
   host. See (4) — they differ in what the voice half gets.
4. **What does the voice half lose with no content script?** `PALETTE_PUBLISH`
   goes page → background → plugin and needs no content script, so voice
   *selection* should work. But mid-utterance narrowing arrives over
   `RELAY_CODEWORDS` to `window.parent`, and the exclusive `PaletteHolder` lives in
   the content-script realm (`DESIGN_CROSS_REALM_CODEWORD_HOLDERS.md`) — with no
   host, badge dimming and prefix narrowing likely go missing. Unverified;
   establish it empirically before designing around it, since it may just work.
5. **Which window's active tab** for Route B's command fallback, given the palette
   window is frontmost when the pick happens.

## Investigation 2026-08-02

Done from the workspace after the palette URL+search arc landed
(`DESIGN_PALETTE_URL_SEARCH.md`) — which changes this note's stakes: the
standalone palette is now a **complete** exit from a restricted page
(bookmark, open tab, never-visited URL, or web search), not just a switcher
over what already exists. Two references above age with that arc:
`open_bookmark` is now `navigate` (rename, phases 2–3), and Route B's "opens
in a new tab, which is exactly what the no-origin-tab path already does"
claim now covers the URL and search rows too — they dispatch `navigate` and
need no origin tab. Q1 also softens: even with zero bookmarks, an NTP-hosted
palette has real content, because typing anything produces a destination.

**Q4 (voice half without a content script) — mostly resolved, statically.**
The voice pipeline splits cleanly by realm:

- *Publish and selection never touch the content script.* The frame posts
  `PALETTE_PUBLISH` over `chrome.runtime.sendMessage` (works from any
  extension page); `publishPaletteVoice` POSTs `/palette` from the
  background; and a spoken pick returns to `handlePaletteVoiceSelect`
  (background), which holds the row→dispatch map itself. Voice selection on
  an NTP palette should work with zero new code.
- *What is genuinely content-script-bound:* the holder registry
  (`labels/holder-registry.ts`) — mid-utterance `narrowByPrefix` fan-out and
  exclusive-claim arbitration — plus the host's `modes.push('palette')`
  mode-stack membership. On a page with no hints, arbitration is moot (there
  are no competing holders to suppress), so the real loss is exactly one
  feature: **live badge dimming/prefix narrowing mid-utterance**, whose
  progress leg today ends at the focused tab's content script.
- Consequence: the missing piece is one background→palette-tab forwarding
  leg for narrow progress (an extension page receives
  `chrome.tabs.sendMessage` addressed to its tab), not a re-architecture.
  Ship without it first — selection works, the rows still filter by typed
  text — and add the leg if mid-utterance dimming proves missed in the
  field.

**Q3 (iframe host vs direct render) — leans direct render.** The host earns
its existence through page isolation (host page must not observe keystrokes)
and Firefox CS-privilege relaying. An NTP extension page needs neither:
there is no untrusted page to isolate from, and the page is fully
privileged, so `PALETTE_BOOTSTRAP` goes direct (already the Chrome
standalone path, verified 2026-07-30). Rendering palette-page directly also
sidesteps the host's mode-stack and holder plumbing consistently with the
Q4 finding — those are content-script concepts, absent by design rather
than half-present.

**New decision surfaced — store-submission sequencing.**
`chrome_url_overrides.newtab` is not just a manifest key: it adds Chrome's
"An extension changed your new tab page" keep-or-revert prompt, an install
warning on the listing, extra CWS review scrutiny (NTP-override extensions
are a policy hot spot), and Firefox's own first-new-tab confirmation. The
browser-store submission arc is at the console-work stage. Options:

1. Submit first, ship Route A in a later update — the initial listing stays
   clean; the update triggers re-review but with an established extension.
2. Claim the NTP from day one — one review cycle, but the scariest
   permission is on the first impression.

Leaning (1); it also buys field time with the standalone palette
(`palette.html` as a pinned/bookmarked tab) to answer Q1/Q2 from experience
before committing to what the NTP shows. Decide before implementation, not
during.
