# Browser-store submission readiness — Chrome Web Store + Firefox AMO

**Status:** OPENED 2026-07-19. Planning + execution doc for getting BranchKit
Browser approved on the Chrome Web Store (CWS) and Mozilla Add-ons (AMO).
Source-grounded audit done this session; workstream below is prioritized by
"will this get us rejected / stall the review" first, polish last.

## Framing decision (read this first)

**The extension is a standalone keyboard-navigation tool. Voice is an opt-in
add-on.** Like Vimium, it paints hint badges and you navigate by keyboard with
zero external dependencies. When the BranchKit desktop app is present, voice
dispatch hooks in on top — but nothing about the core value requires it. See
`project_extension_independent` (memory) and the extension's independence
posture: the extension owns its command vocabulary; the platform consumes it.

Why this matters for submission:
- **A reviewer can verify the full core experience with zero setup** — install,
  press the activation key, see badges, type a codeword, element activates. No
  "install a companion app or nothing happens" rejection risk.
- **It is the clean "single purpose"** CWS demands: *hands-free / keyboard
  navigation of web pages via hint badges.* Voice is one input method for that
  single purpose, not a second purpose.
- Every listing/description/review-note must lead with the standalone story and
  present the desktop app as an enhancement, never a requirement.

Action: rewrite `STORE_LISTING.md` and `PRIVACY.md` intros and the "Requirements"
section so standalone-keyboard is the headline and the app is "optional, adds
voice." (Today's listing says "Requirements: BranchKit desktop app" — that
framing is wrong and a rejection risk.)
**DONE 2026-07-19.** Both files rewritten standalone-first: listing leads with the
real default Vim-style keymap (`f` to click, `j`/`k` scroll, `/` find, `yy` copy —
all verified against `command-catalog.ts`), voice presented as opt-in; short desc
117/132 chars; the full per-permission justification table + "comparable approved
extensions" (Vimium/Rango) + "how to verify with zero setup" review notes are now
embedded in `STORE_LISTING.md`. `PRIVACY.md` reframed ("None leaves the device;
with the optional app, localhost only"), `activeTab` row removed, date bumped.

---

## What's already good (verified this session)

- No remote code, no `eval` / `new Function` / remote `.src` (grep-clean).
- No outbound network beyond localhost `127.0.0.1` (companion app).
- esbuild bundles locally; nothing loaded from a CDN at runtime.
- All declared permissions are actually used (sessions, webNavigation, alarms,
  scripting all have live call sites — no unused-permission rejection).
- Firefox add-on `id` is set (`browser_specific_settings.gecko.id`), and
  `npm run lint:firefox` (web-ext lint) already exists.
- **Per-target manifest build is already correct** (`scripts/build-manifest.mjs`):
  one base `manifest.json` (Firefox-shaped), deterministic Chrome/Firefox
  patches. Chrome gets `offscreen` + `background.service_worker`; Firefox strips
  `offscreen`, uses `background.scripts`, and declares
  `gecko.data_collection_permissions: {required: ['none']}`. **This is the seam
  for any manifest change below** — edit base for shared, or the target branch
  for browser-specific. (Verified against `dist/chrome` and `dist/firefox`.)
- **`chrome.offscreen` is correctly permissioned in the Chrome build** — an
  earlier read of the *base* manifest suggested it was missing; the built Chrome
  output declares it and PRIVACY.md is accurate. Not a blocker. Recorded so it
  isn't re-investigated.
- `bootstrap.js` (the MAIN-world script) is ~689 bytes — already minimal, which
  is exactly what P1 #3 wants.

---

## Precedent: Vimium & Rango (verified manifests, 2026-07-19)

Two approved, cross-store extensions do almost exactly what we do. Pulled their
real manifests this session; cite them in review notes — "this is the same
pattern as $APPROVED_TOOL" is the single most effective permission justification.

**Vimium** (MV3, keyboard hint-nav — our standalone twin):
`github.com/philc/vimium/manifest.json`
- permissions: `tabs, bookmarks, history, storage, sessions, notifications,
  scripting, favicon, webNavigation, search`
- host_permissions: `<all_urls>`; content_scripts match `<all_urls>` +
  `file:///`, `run_at: document_start`, `all_frames: true`
- Requests MANY more permissions than us (bookmarks/history/search/favicon) and
  is approved. Public maintainer stance: the broad warning just means "load our
  JS into every page; we never talk to a server." Uses `sessions` and
  `scripting` — direct precedent for ours.

**Rango** (MV3, voice+keyboard hints via Talon — the tool our own audit
benchmarks against): `github.com/david-tejada/rango/src/manifests/{chrome,firefox,safari}/`
- Chrome permissions: `storage, tabs, activeTab, clipboardRead, clipboardWrite,
  notifications, webNavigation, offscreen, contextMenus, bookmarks`
- Firefox: same minus `offscreen`. **Per-browser manifests, offscreen
  Chrome-only — our exact pattern**, and it ships a Safari manifest too (proof
  the multi-manifest approach scales to a 3rd store later).
- Notable: Rango declares **no `host_permissions` array and no
  `web_accessible_resources`** — it gets host access purely via the
  content_scripts `<all_urls>` match + `activeTab`.

**What this establishes for us:**
- `<all_urls>`, `tabs`, `storage`, `webNavigation` — declared by BOTH. Non-issue.
- `sessions`, `scripting` — Vimium. `activeTab`, `offscreen` — Rango.
  Every permission we have except two is precedented by an approved peer.
- The two without peer precedent: **`alarms`** (innocuous, no scary warning) and
  **`http://127.0.0.1/*`** (our companion connection — the one genuinely novel
  ask; give it the clearest justification).
- **We are LEANER than Rango**: we omit clipboardRead/Write, contextMenus,
  bookmarks, notifications. Good story for review notes.
- **Host-narrowing reality check:** Rango runs a hint tool with no `<all_urls>`
  host_permissions (match + activeTab only). We can't go that lean *as-is*
  because we (a) connect to `127.0.0.1` and (b) use `scripting.executeScript` to
  re-inject non-active tabs on SSE events — neither is covered by activeTab. So
  our `<all_urls>` host is justified by the injection + companion architecture,
  not laziness. Worth a sentence in the note.

## Workstream

### P0 — Blockers / inconsistencies (fix before any submission)

*(Former item 1 — "offscreen permission missing" — WITHDRAWN after checking the
built output; the Chrome build declares it. See "What's already good.")*

1. **Per-permission justifications — DRAFTED below** (was: only `<all_urls>` +
   `tabs` covered). Paste each into the CWS "justify permissions" field; the
   precedent column goes in the free-text review notes. Verified against live
   call sites + the Vimium/Rango manifests above.

   | Permission | Justification (BranchKit's actual use) | Precedent |
   |---|---|---|
   | `<all_urls>` host | Paint hint badges on / read interactive elements of any site (can't predict which sites the user visits), and re-inject the content script into pre-install tabs. Element data (labels, CSS selectors) is used only to build hint mappings and, when the optional app is present, sent only to localhost — never to any server. | Vimium (explicit), Rango (via CS match) |
   | `http://127.0.0.1/*` host | **Optional** connection to the user's own on-device BranchKit desktop app (the voice add-on). Localhost only; no external servers. The extension is fully functional without it (keyboard mode). | Novel — give the clearest wording |
   | `tabs` | Route an activated hint/voice action to the correct tab; propagate badge-setting changes to open tabs; tab-navigation commands (next/prev/MRU). | Vimium, Rango |
   | `storage` | Persist badge display mode (word/letter/both) and keymap preferences. | Vimium, Rango |
   | `scripting` | Lazily inject the content script into tabs that predate install or were discarded (`scripting.executeScript`, injection.ts). | Vimium |
   | `webNavigation` | Detect SPA client-side route changes (`onHistoryStateUpdated` / `onReferenceFragmentUpdated`) to re-scan hints — nothing more. | Vimium, Rango |
   | `sessions` | The "reopen last-closed tab" command (`chrome.sessions.restore()`, background.ts:452 — the Ctrl/Cmd+Shift+T equivalent). | Vimium |
   | `alarms` | A 30s heartbeat checking liveness of the optional desktop-app connection. | (innocuous; no peer, no scary warning) |
   | `offscreen` (Chrome only) | Hold a persistent `EventSource` to the desktop app in an offscreen document — an MV3 service worker can't keep a long-lived connection. Absent from the Firefox build. | Rango (also Chrome-only) |

   **`activeTab` — RECOMMEND DROP.** It's redundant: we already hold `<all_urls>`
   host, which subsumes active-tab access, so it grants nothing extra and reads
   as over-asking. (Rango keeps `activeTab` because it declares *no* `<all_urls>`
   host — there it's load-bearing; for us it isn't. Vimium, which does declare
   `<all_urls>` host, omits `activeTab` — the closer precedent.) Verify nothing
   references `chrome.tabs` in a way that depends on the activeTab grant before
   removing from the base manifest.

### P1 — High-scrutiny surfaces (pre-justify, minimize footprint)

3. **`world: "MAIN"` content script at `document_start`, all frames, all urls.**
   Among the most-scrutinized MV3 patterns (runs in the page's JS context).
   Legitimate here (bootstrap bridge needs page-context the ISOLATED world can't
   reach), but:
   - Keep the MAIN-world file (`bootstrap.js`) as small/auditable as possible —
     it's the reviewer's first read.
   - Add a review note: why MAIN world, what it touches, and that it bridges to
     the ISOLATED content script rather than reading page data for exfiltration.

4. **`web_accessible_resources` (`palette.html`/`palette.js`) exposed to
   `<all_urls>`** — lets any site probe `chrome-extension://<id>/palette.html`
   to fingerprint the extension. CWS increasingly flags this.
   - Fix: set `"use_dynamic_url": true` on that WAR entry (Chrome MV3 rotates the
     URL), or narrow `matches` if the palette only needs specific origins.
   - **Seam:** `use_dynamic_url` is Chromium MV3; Firefox support is version-gated
     and uncertain — add it in the **chrome branch of `build-manifest.mjs`** (same
     pattern as `offscreen`), not the shared base, until Firefox support is
     confirmed. DONE 2026-07-19 (chrome branch; Firefox WAR unchanged).

5. **Localhost companion — pre-empt "what are you talking to?"** In review notes,
   state plainly: the SSE stream carries **structured action data, never code**
   (nothing from localhost is eval'd or injected as HTML), and the app is the
   user's own on-device install. (Optional future: Chrome **native messaging** is
   the maximally-blessed companion channel and sidesteps the localhost-permission
   question — architecture change, not a launch requirement.)

### P2 — Firefox / AMO specifics

6. **Reproducible source submission.** AMO requires reviewable source + exact
   build steps when the submitted code is bundled (esbuild `bundle: true`).
   Produce a source archive + a README that reproduces `dist/firefox` byte-for-
   byte: Node version, `npm ci`, `npm run build:release` (or `package:firefox`).
   This is the #1 AMO stall — get it reproducible before submitting.
   **DONE 2026-07-19.** `SOURCE_BUILD.md` written; `.nvmrc` pins Node 24; build
   ID made overridable via `BK_BUILD_ID` (build.mjs) — verified two release
   builds with the same `BK_BUILD_ID` are byte-identical (`diff -rq` clean). The
   timestamp was the only nondeterministic input; it's now pinnable for reviewers.

7. **`web-ext lint` — 0 errors, 5 warnings (baseline 2026-07-19).** Passes AMO
   validation. All 5 warnings are `UNSAFE_VAR_ASSIGNMENT` (innerHTML) in
   `options.js` (1) and `content.js` (rest) — pre-existing, not from the WAR
   change. Warnings don't block submission, but innerHTML is a manual-review
   hot spot: an AMO reviewer may ask to see each assignment is from a trusted/
   sanitized source (not page-derived strings). Action: audit those sites, and
   where the string is static/extension-controlled, switch to `textContent` /
   `replaceChildren` / a DOM builder to zero them out. Track before packaging.
   **DONE 2026-07-19.** Audited: all 3 innerHTML sites were static extension
   constants (2× `MIC_SVG`, 1 usage literal) — no page/user input. Converted to
   DOM construction via a shared `render/mic-glyph.ts` helper (also dedupes the
   `MIC_SVG` that was copy-pasted across help-overlay.ts + keymap-options.ts —
   see [[feedback_no_dual_sync_coupling]]) + `el('b',…)` builders for the usage
   note. Verified: **0 innerHTML in all bundles**, typecheck clean, tests green.
   Remaining lint = **3 benign warnings**: guarded `chrome.offscreen.*`
   ("not implemented by Firefox"), runtime-gated behind `!!chrome.offscreen`
   (Firefox uses the direct-SSE path). Accepted — zeroing them would mean
   splitting background.ts into per-browser modules; not worth it, and AMO does
   not reject on guarded-degradation notices.

### P3 — Store-side disclosure hygiene (separate from PRIVACY.md)

8. **CWS "Privacy practices" form** — affirmatively declare collection of
   **"website content"** (element labels can carry form-field text / PII),
   certify localhost-only handling, no selling, no unrelated use. This is a
   separate dashboard form; PRIVACY.md alone doesn't satisfy it.
   - AMO note: the Firefox **manifest-level** disclosure is already handled
     (`data_collection_permissions: {required: ['none']}` in build-manifest.mjs).
     Reconcile that "none" claim with CWS's "website content" declaration — they
     describe the same reality (element text is read transiently and sent only to
     localhost, never stored/collected by us), but the two stores use different
     vocabularies. Make sure the listing copy is consistent with both.

9. **Single-purpose statement** — frame hints + keyboard + palette + tab markers
   (+ optional voice) as the *one* purpose: keyboard/voice navigation of web
   pages via hint badges. Keep the listing tight so it doesn't read as
   feature-sprawl. Don't use Chrome/Edge/Arc/Firefox logos or imply endorsement
   (naming them as compatibility is fine).

### P4 — Approval speed-ups (not blockers)

10. **Demo video/GIF** in the listing — accessibility reviews move faster when
    the value is obvious in ~10s; this extension is very demonstrable, and the
    demo can be **keyboard-only** (no app install for the reviewer).
11. **Lead the description with the standalone keyboard story** (per Framing
    Decision) so a reviewer who installs without the app still sees a working,
    verifiable tool.

---

## Sequencing

1. P0 first — they're mechanical and gate everything (manifest fix + full
   justification table). Land as one commit.
2. Framing rewrite (`STORE_LISTING.md` + `PRIVACY.md`) alongside P0 — the
   justifications and the standalone framing are written together.
3. P1 (use_dynamic_url + bootstrap audit + MAIN-world review note).
4. P2 (AMO reproducible-source README + clean web-ext lint) — needed only for
   the Firefox track; can run in parallel with CWS prep.
5. P3/P4 are submission-time (dashboard forms, listing assets), not code.

## Open questions

- ~~Keep `activeTab` or drop it?~~ **RESOLVED — DROPPED 2026-07-19.** Redundant
  with `<all_urls>` host; the `activeTab` hits in `src/` are a local variable, not
  the permission (popup gets the tab via `chrome.tabs.query` + `<all_urls>` host).
  web-ext lint still 0 errors. Vimium precedent (host, no activeTab).
- Native messaging vs localhost HTTP for the companion — defer; localhost is
  acceptable to ship. Revisit if CWS pushes back.
- ~~Does the standalone keyboard path have a first-run hint/onboarding so a
  reviewer (and a real user without the app) discovers the activation key?~~
  **RESOLVED — welcome page added 2026-07-19.** Investigation: on fresh install
  nothing opened (`onInstalled` only re-injected content scripts); the popup is a
  config panel with a footer "? Help" button but no lead "press F" cue; the `?`
  help overlay has the teaching line but you must know to open it. Fix: a
  self-contained `welcome.html` (matches the popup palette, JS-free, standalone-
  first — "press F", Vim cheats, voice as optional) opened via `onInstalled` only
  on `reason === 'install'`. Directly answers the reviewer "installed it, nothing
  happened" risk. Ships to both dists; lint clean. Possible follow-on (deferred):
  a dismissible "New here? press F" banner atop the popup — lower priority since
  the footer Help button + welcome page cover discovery.
