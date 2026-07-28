/**
 * BranchKit Browser — the content script's message table, over the REAL
 * chrome.runtime.onMessage boundary.
 *
 * The gap DESIGN_ENTRY_POINT_TOPOLOGY.md section 7 recorded after phase 1 and
 * never closed: a green suite here is not a green browser. Every handler in
 * both tables only ever runs behind onMessage, and nothing in tsc, vitest or
 * the build exercises that edge — the unit tests call handlers directly. The
 * specific risk is the response contract: a handler that should answer and
 * does not leaves the sender awaiting forever, silently.
 *
 * So this sends each type from the service worker to a real tab and reads what
 * comes back. Opt-in (npm run harness:messages) rather than part of the
 * lifecycle run, so it does not move that harness's PASS/SKIP baseline.
 *
 * It counts its own probes: an abort partway through reports as an abort, not
 * as a pass over an empty list. It shipped with exactly that bug and announced
 * ALL PROBES PASS having run none.
 *
 * SECOND HALF (section 6i): one probe per BRANCHKIT_ACTION arm. The split that
 * moves ~200 of those 403 lines out of content.ts is a pure relocation, and a
 * harness that never drives an arm cannot prove a relocation preserved it — it
 * can only fail to notice. realinput drives real KEYS, which reach the same
 * verbs by an entirely different path (armHintAction + hint mode); the voice
 * arms resolve a codeword through three tiers and act on it. So they are probed
 * here, before the move.
 *
 * Two observables carry most of the weight:
 *   - DISPATCH_RESULT, the arm's own structured report, captured in the SW.
 *     Its `detail` discriminates the arms from each other: an arm that focused
 *     when it should have copied says so.
 *   - a page-world effect for the arms that report nothing (badge visibility,
 *     activeElement, a pointerover the page can see, an iframe appearing).
 *
 * `pipelines.ingest_transcript` is deliberately NOT used: CLAUDE.md is explicit
 * that it really executes actions on the user's own machine.
 */
import { startFixtureServer, launchHarness, waitForBadges, settle } from '../lifecycle/driver.mjs';

const fixture = await startFixtureServer();
const url = fixture.base;
const { ctx, sw } = await launchHarness('msgtable');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

/** How many probes a complete run reports. A run that stops short says so. */
const EXPECTED = 32;

try {
  // The profile is persistent and reused between runs, so every piece of state
  // a probe WRITES has to be reset here or run N+1 starts where run N stopped.
  // The set_badge_mode arm writes badgeDisplayMode; the reference arms write
  // branchkit_references. Both were silently order-dependent before this.
  await sw.evaluate(async () => {
    await chrome.storage.sync.set({ badgeDisplayMode: 'letter' });
    await chrome.storage.local.remove('branchkit_references');
  });

  const page = await ctx.newPage();
  await page.goto(`${url}/a.html`);
  // Open the badge shadow roots. The arm probes need to read the codeword a
  // badge is SHOWING — that string is what the voice path resolves — and the
  // affordance is read once at content-script module load, so it needs a
  // reload to take. Asserted below rather than assumed: a closed shadow would
  // silently reduce every codeword to '' and the arm probes to nothing.
  await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
  await page.reload();
  await waitForBadges(page, { min: 1 });
  await settle(1000);

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id);
  const send = (msg, opts) => sw.evaluate(
    ([id, m, o]) => chrome.tabs.sendMessage(id, m, o ?? {}).catch((e) => ({ __err: String(e) })),
    [tabId, msg, opts ?? null],
  );
  const act = (action, params = {}) => send(
    { type: 'BRANCHKIT_ACTION', payload: { action, params, correlation_id: 'tr_probe' } },
    { frameId: 0 },
  );

  // The content script reports what it did by sending the SW a message. Tap
  // that stream: it is the one observable the acting arms all share, and it
  // carries which codeword resolved to which element. Installed alongside
  // routeMessage — returning undefined leaves the router's contract alone.
  await sw.evaluate(() => {
    globalThis.__probeSeen = [];
    chrome.runtime.onMessage.addListener((m) => { globalThis.__probeSeen.push(m); });
  });
  // Drains AND clears, so each probe reads only its own traffic. Returns []
  // if the SW restarted and lost the array — which fails the probe that
  // expected a message rather than quietly passing it.
  const drain = () => sw.evaluate(() => {
    const seen = globalThis.__probeSeen ?? [];
    globalThis.__probeSeen = [];
    return seen;
  });
  const lastDispatch = async (action) => {
    const seen = await drain();
    const hits = seen.filter((m) => m.type === 'DISPATCH_RESULT' && m.payload?.action === action);
    return hits.length ? hits[hits.length - 1].payload : null;
  };

  // GET_PAGE_STATUS — sync value response through the router.
  const status = await send({ type: 'GET_PAGE_STATUS' }, { frameId: 0 });
  check('GET_PAGE_STATUS', status && typeof status.hintCount === 'number' && !status.__err,
    JSON.stringify(status));

  // GET_FOCUS_STATUS — the map that moved to a brand-new module.
  const focus = await send({ type: 'GET_FOCUS_STATUS' }, { frameId: 0 });
  check('GET_FOCUS_STATUS', focus && typeof focus.focused === 'boolean' && !focus.__err,
    JSON.stringify(focus));

  // Badge text, read out of the shadow root the reload just opened. Asserted
  // as its own probe: a closed shadow would reduce every codeword below to ''
  // and every arm probe to nothing.
  const badgeText = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-branchkit-hint]')]
      .map((h) => h.shadowRoot?.querySelector('.bk-inner')?.textContent?.trim())
      .filter((t) => t));
  const shownAsLetters = await badgeText();
  check('badge shadow is readable', shownAsLetters.length > 0,
    `${shownAsLetters.length} badge labels: ${JSON.stringify(shownAsLetters.slice(0, 4))}`);

  // RESOLVE_HINT — binds the live store inside the module now. A REAL
  // codeword, not the empty string the first version read out of a closed
  // shadow root: an empty codeword exercises only the not-found path, and
  // would pass against a handler that ignored its argument entirely (the
  // same defect section 6g.6 found in this handler's unit test). The letter
  // form also exercises findWrapper's display-form fallback, which
  // `store.byCodeword` alone does not answer.
  const hint = await send({ type: 'RESOLVE_HINT', codeword: shownAsLetters[0] }, { frameId: 0 });
  check('RESOLVE_HINT', hint && hint.ok === true && !!hint.selector && !hint.__err,
    `codeword=${JSON.stringify(shownAsLetters[0])} -> ${JSON.stringify(hint)}`);

  // TAB_MARKER — fire-and-forget, observed in the page.
  // Strip any marker the SW already applied — the fixture tab has one.
  const before = (await page.title()).replace(/^\[[a-z]+\] /, '');
  await send({ type: 'TAB_MARKER', letters: 'zq' }, { frameId: 0 });
  await settle(500);
  const after = await page.title();
  check('TAB_MARKER', after === `[zq] ${before}`, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  // SET_BADGES_VISIBLE — acts AND answers. `[data-bk-shown]` is the badge's
  // own light-DOM mirror of shown/hidden (render/hints.ts), so the count is
  // the paint state rather than a guess at which element carries the hide —
  // the first version filtered on the HOST's computed display and read 14
  // painted badges while every one of them was down.
  const visibleBadges = () => page.evaluate(() =>
    document.querySelectorAll('[data-branchkit-hint][data-bk-shown]').length);
  const hidden = await send({ type: 'SET_BADGES_VISIBLE', visible: false }, { frameId: 0 });
  await settle(800);
  const paintedWhileHidden = await visibleBadges();
  check('SET_BADGES_VISIBLE', hidden && hidden.badgesVisible === false && !hidden.__err && paintedWhileHidden === 0,
    `answer=${JSON.stringify(hidden)} visible_badges_after=${paintedWhileHidden}`);
  await send({ type: 'SET_BADGES_VISIBLE', visible: true }, { frameId: 0 });
  await settle(800);

  // BRANCHKIT_ACTION passthrough — a benign, observable verb. scroll_down
  // is in DISPATCH_PASSTHROUGH_ACTIONS, so this is the passthrough ARM as well
  // as the message type.
  // Make the page scrollable so scroll_down has somewhere to go.
  await page.evaluate(() => { document.body.style.minHeight = '5000px'; });
  await settle(300);
  const y0 = await page.evaluate(() => window.scrollY);
  await act('scroll_down');
  await settle(900);
  const y1 = await page.evaluate(() => window.scrollY);
  check('ARM passthrough (scroll_down)', y1 > y0, `scrollY ${y0} -> ${y1}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(600);

  // PALETTE_CLOSE — the ONE handler whose response carries an ordering
  // guarantee: background/palette.ts awaits it before dispatching, and its
  // catch is silent, so a handler that stopped answering would look exactly
  // like a dead tab while the action ran against a still-mounted overlay.
  // Answering `true` is the contract; the close itself is idempotent.
  const closed = await send({ type: 'PALETTE_CLOSE' }, { frameId: 0 });
  check('PALETTE_CLOSE answers', closed === true, JSON.stringify(closed));

  // PALETTE_COMMAND — fire-and-forget INTO the dispatcher, so it exercises
  // the command table from the message side. scroll_top is benign and visible.
  //
  // This probe has a history: a fixed 200ms delay read the page 91px into a
  // 400px scroll, and the wait added to fix that swallowed its own timeout
  // (`.catch(() => {})`), so a scroll that never landed still fell through to
  // the assertion and reported as a DISPATCHER failure. Observed three times
  // in twelve runs at `scrollY 82 -> 2` — the same shape as the original 91.
  // The wait did not fix the flake, it made it rarer and kept blaming the
  // wrong thing.
  //
  // Two changes. First, settle before setting the precondition: the two
  // probes above drive scroll_down and a reset through the extension's own
  // animated scroller, and a scrollTo issued into an easing animation is the
  // best available explanation for a partial landing (suspected, not proven —
  // the flake is intermittent and was not reproduced on demand).
  //
  // One lead for whoever settles it, gathered by forcing the wait to time
  // out: five seconds AFTER a successful `scrollTo(0, 400)` the page reads
  // 82, the same value the real failures report. So the position is not
  // stable after the scrollTo — the passing path passes because it reads the
  // instant scrollY crosses 380, not because the page stays there. The
  // stability wait below addresses the wrong end of that if the real cause is
  // something re-scrolling AFTER the setup rather than before it.
  //
  // Second, and
  // this part is certain: a precondition that does not hold is reported AS a
  // precondition, so the next person reads "the harness never scrolled"
  // instead of "the dispatcher is broken".
  await page.waitForFunction(() => {
    const y = window.scrollY;
    const settled = window.__probeLastY === y;
    window.__probeLastY = y;
    return settled;
  }, undefined, { timeout: 5000, polling: 250 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 400));
  const scrolledTo400 = await page
    .waitForFunction(() => window.scrollY >= 380, undefined, { timeout: 5000 })
    .then(() => true, () => false);
  const yBefore = await page.evaluate(() => window.scrollY);
  const geom = await page.evaluate(() => ({
    h: document.documentElement.scrollHeight, vh: window.innerHeight,
    minH: document.body.style.minHeight,
  }));
  await send({ type: 'PALETTE_COMMAND', action: 'scroll_top', params: {} }, { frameId: 0 });
  await settle(1200);
  const yTop = await page.evaluate(() => window.scrollY);
  // Near the top rather than exactly 0: scroll_top animates, so the settled
  // value lands within a pixel or two. What is being probed is that the
  // message reached the dispatcher at all, not the easing curve.
  check('PALETTE_COMMAND reaches the dispatcher', scrolledTo400 && yTop < 50,
    scrolledTo400
      ? `scrollY ${yBefore} -> ${yTop} (doc ${geom.h}, viewport ${geom.vh}, body min-height ${JSON.stringify(geom.minH)})`
      : `HARNESS PRECONDITION FAILED, not the dispatcher: the page never reached 400 `
        + `(stalled at ${yBefore}) so scroll_top had nothing to undo. `
        + `doc ${geom.h}, viewport ${geom.vh}, body min-height ${JSON.stringify(geom.minH)}`);

  // TAB_MARKER_REAPPLY — restores the marker after the page overwrites the
  // title, which is the whole reason the message exists.
  await send({ type: 'TAB_MARKER', letters: 'zq' }, { frameId: 0 });
  await settle(300);
  await page.evaluate(() => { document.title = 'Rewritten By The Page'; });
  await settle(200);
  await send({ type: 'TAB_MARKER_REAPPLY' }, { frameId: 0 });
  await settle(500);
  const reapplied = await page.title();
  check('TAB_MARKER_REAPPLY', reapplied === '[zq] Rewritten By The Page', JSON.stringify(reapplied));

  // MARK_RESTORE — a global-mark jump landing on this tab. Top frame only,
  // and the one handler that writes scroll position.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(200);
  await send({ type: 'MARK_RESTORE', scrollX: 0, scrollY: 250, hash: '' }, { frameId: 0 });
  await settle(600);
  const restored = await page.evaluate(() => window.scrollY);
  check('MARK_RESTORE', restored > 0, `scrollY -> ${restored}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(400);

  // An unknown type must be ignored, not throw the listener.
  await send({ type: 'NOT_A_REAL_TYPE' }, { frameId: 0 });
  const still = await send({ type: 'GET_PAGE_STATUS' }, { frameId: 0 });
  check('unknown type does not break the table',
    still && typeof still.hintCount === 'number', JSON.stringify(still));

  // --- BRANCHKIT_ACTION, one probe per arm (section 6i) ---
  //
  // Everything above this line runs in the default letter display mode, which
  // is also what the TAB_MARKER probes assume: marker letters render through
  // the same display mode, so a word-mode tab reads "[z q]".

  // set_badge_mode — writes storage AND repaints. Word mode is also what
  // the arm probes below need: the badge then shows the canonical spoken form,
  // which is exactly the string `store.byCodeword` takes and the voice plugin
  // sends. In letter mode the badge shows "as" and the voice path could not
  // resolve it.
  await act('set_badge_mode', { mode: 'word' });
  await settle(1200);
  const shownAsWords = await badgeText();
  const storedMode = await sw.evaluate(
    async () => (await chrome.storage.sync.get('badgeDisplayMode')).badgeDisplayMode);
  check('ARM set_badge_mode',
    storedMode === 'word' && shownAsWords.length === shownAsLetters.length
    && shownAsWords.every((t) => t.includes(' ') || t.length > 2),
    `stored=${storedMode} ${JSON.stringify(shownAsLetters.slice(0, 3))} -> ${JSON.stringify(shownAsWords.slice(0, 3))}`);

  // Map each codeword to the element it names, through RESOLVE_HINT — the one
  // message that answers with a selector. This is what lets an arm probe
  // assert WHICH element was acted on rather than that something was.
  const byName = new Map();
  for (const cw of shownAsWords) {
    const r = await send({ type: 'RESOLVE_HINT', codeword: cw }, { frameId: 0 });
    if (r && r.ok && r.accessibleName) byName.set(r.accessibleName, { cw, ...r });
  }
  const targetFor = (name) => {
    const hit = byName.get(name);
    if (!hit) throw new Error(`no badge resolves to ${JSON.stringify(name)} — have ${[...byName.keys()]}`);
    return hit;
  };

  // The element verbs resolve a codeword and act ON it without following it.
  // A different element per verb, so a verb that resolved the wrong badge
  // fails instead of landing on the one every probe happens to share.

  // hover_hint — a real pointerover the PAGE can see, on the named element.
  await page.evaluate(() => {
    window.__hovered = [];
    document.addEventListener('pointerover', (e) => {
      window.__hovered.push((e.target.textContent || '').trim());
    }, true);
  });
  await drain();
  const hoverT = targetFor('alpha');
  await act('hover_hint', { codeword: hoverT.cw });
  await settle(700);
  const hovered = await page.evaluate(() => window.__hovered);
  const hoverR = await lastDispatch('hover_hint');
  check('ARM hover_hint', hovered.includes('alpha') && hoverR?.ok === true && hoverR.detail === 'hover dispatched',
    `pointerover=${JSON.stringify(hovered)} report=${JSON.stringify(hoverR)}`);

  // focus_hint — activeElement, read from the page.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await drain();
  const focusT = targetFor('beta');
  await act('focus_hint', { codeword: focusT.cw });
  await settle(700);
  const active = await page.evaluate(() => (document.activeElement?.textContent || '').trim());
  const focusR = await lastDispatch('focus_hint');
  check('ARM focus_hint', active === 'beta' && focusR?.ok === true && focusR.detail === 'focused',
    `activeElement=${JSON.stringify(active)} report=${JSON.stringify(focusR)}`);

  // copytext_hint — the CLIPBOARD, not just the arm's own report. The report
  // sets detail = 'text copied' from the element's text alone, so it says the
  // same thing whether or not the copy actually happened; the clipboard is
  // what distinguishes those. Pre-seeded with a sentinel so a stale value
  // from an earlier run cannot pass this.
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  await page.evaluate(() => navigator.clipboard.writeText('__probe_sentinel__'));
  await drain();
  const copyT = targetFor('gamma');
  await act('copytext_hint', { codeword: copyT.cw });
  await settle(700);
  const copyR = await lastDispatch('copytext_hint');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('ARM copytext_hint', clip === 'gamma' && copyR?.ok === true
    && copyR.detail === 'text copied' && copyR.elem_tag === 'button',
    `clipboard=${JSON.stringify(clip)} report=${JSON.stringify(copyR)}`);

  // A codeword that names nothing must be REFUSED, not acted on. Same arm,
  // opposite outcome — without this every probe above would pass against a
  // verb that acted on whatever it found first.
  await drain();
  await act('focus_hint', { codeword: 'nosuchcodeword' });
  await settle(700);
  const missR = await lastDispatch('focus_hint');
  check('ARM element verbs refuse an unknown codeword',
    missR?.ok === false && missR.taken === 'skipped', JSON.stringify(missR));

  // caret_hint — enters caret mode AT the element. The report's `detail` is
  // written unconditionally, so it alone would pass against an arm that
  // resolved the element and then did nothing; the live DOM selection is the
  // half that can only be true if enterAt ran.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await drain();
  const caretT = targetFor('delta');
  await act('caret_hint', { codeword: caretT.cw });
  await settle(700);
  const caretR = await lastDispatch('caret_hint');
  const caretAt = await page.evaluate(() => {
    const n = window.getSelection()?.anchorNode;
    if (!n) return null;
    const el = n.nodeType === 1 ? n : n.parentElement;
    return (el?.closest('button')?.textContent || el?.textContent || '').trim();
  });
  check('ARM caret_hint', caretR?.ok === true && caretR.detail === 'caret at element'
    && caretAt === 'delta', `selection at ${JSON.stringify(caretAt)} report=${JSON.stringify(caretR)}`);

  // SELECTION_ACTIONS, with caret mode LIVE. `ok` alone only mirrors
  // caret.isActive(), so it would hold against an arm that consulted the caret
  // and then never applied the command — hence a verb with a visible result
  // (select the word under the caret) and the selected TEXT as the assertion.
  const selectedText = () => page.evaluate(() => (window.getSelection()?.toString() ?? '').trim());
  await drain();
  await act('select_whole', { granularity: 'word' });
  await settle(500);
  const wholeLive = await lastDispatch('select_whole');
  const selLive = await selectedText();
  check('ARM selection (caret live)', wholeLive?.ok === true && selLive === 'delta',
    `selected=${JSON.stringify(selLive)} ${JSON.stringify(wholeLive)}`);

  // escape — the Esc cascade, which unwinds a caret in TWO stages: the first
  // escape is an "inner" peel that collapses the visual selection and leaves
  // the caret entry on the mode stack, the second peels the entry itself.
  // Both report as the `selection` layer. Asserting the staged shape rather
  // than one peel is what distinguishes the cascade from a plain caret exit —
  // an earlier version of this probe used a selection verb that never entered
  // visual mode, so it only ever saw the second stage and would have passed
  // against a cascade with no inner peel at all.
  await drain();
  await act('escape');
  await settle(700);
  const escInner = await lastDispatch('escape');
  const selAfterInner = await selectedText();
  await drain();
  await act('escape');
  await settle(700);
  const escEntry = await lastDispatch('escape');
  // The inner peel collapses "delta" back to the one-character block caret —
  // NOT to an empty selection, which is what a caret EXIT leaves. That is the
  // discriminator: an implementation that skipped the inner stage would have
  // exited on the first escape, leaving nothing for the second to peel, and
  // the second call would answer 'nothing to close' with ok false.
  check('ARM escape peels, in two stages',
    escInner?.detail === 'escape: selection' && escInner.ok === true
    && selAfterInner.length === 1 && selAfterInner !== selLive
    && escEntry?.detail === 'escape: selection' && escEntry.ok === true,
    `inner=${JSON.stringify(escInner?.detail)} selection ${JSON.stringify(selLive)} -> ${JSON.stringify(selAfterInner)} entry=${JSON.stringify(escEntry?.detail)}`);

  // …and the same selection action now refuses, because escape took the caret
  // away. This is what makes the probe above mean anything: without it, every
  // selection assertion would also hold for an arm that acts unconditionally.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await drain();
  await act('select_whole', { granularity: 'word' });
  await settle(500);
  const wholeDead = await lastDispatch('select_whole');
  const selDead = await selectedText();
  check('ARM selection (caret gone) refuses',
    wholeDead?.ok === false && wholeDead.detail === 'caret mode not active' && selDead === '',
    `selected=${JSON.stringify(selDead)} ${JSON.stringify(wholeDead)}`);

  // Peel whatever else the cascade still holds, so the badge probes below
  // start from a clean page.
  await act('escape');
  await settle(700);
  await send({ type: 'SET_BADGES_VISIBLE', visible: true }, { frameId: 0 });
  await settle(800);

  // noop — mid-codeword progress. The prefix narrows the painted set
  // through the holder registry's one fan-out; '' resets it. Narrowing marks
  // the non-candidates with the `filtered` class INSIDE the shadow root — it
  // is not the same mechanism as hiding, which is why this counts candidates
  // rather than reusing visibleBadges().
  const candidateBadges = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-branchkit-hint]')]
      .map((h) => h.shadowRoot?.querySelector('.bk-inner'))
      .filter((i) => i && !i.classList.contains('filtered')).length);
  const candidatesAll = await candidateBadges();
  const prefix = (await badgeText()).map((t) => t[0]).find(Boolean);
  await act('noop', { prefix });
  await settle(800);
  const candidatesNarrow = await candidateBadges();
  await act('noop', { prefix: '' });
  await settle(800);
  const candidatesReset = await candidateBadges();
  check('ARM noop narrows and resets',
    candidatesAll > 0 && candidatesNarrow > 0 && candidatesNarrow < candidatesAll
    && candidatesReset === candidatesAll,
    `candidates ${candidatesAll} -> ${candidatesNarrow} (prefix ${JSON.stringify(prefix)}) -> ${candidatesReset}`);

  // toggle_hints — the voice twin of Shift+F.
  await act('toggle_hints');
  await settle(900);
  const offStatus = await send({ type: 'GET_PAGE_STATUS' }, { frameId: 0 });
  await act('toggle_hints');
  await settle(900);
  const onStatus = await send({ type: 'GET_PAGE_STATUS' }, { frameId: 0 });
  check('ARM toggle_hints', offStatus?.badgesVisible === false && onStatus?.badgesVisible === true,
    `badgesVisible ${offStatus?.badgesVisible} -> ${onStatus?.badgesVisible}`);

  // rescan — the content side of the background's SPA-nav signal. It
  // announces itself to the SW with the reason it was given, so the probe can
  // assert the params reached the handler, not just that nothing threw.
  await drain();
  await act('rescan', { reason: 'probe_rescan', from_cache: 'true' });
  await settle(900);
  const rescanLog = (await drain()).filter(
    (m) => m.type === 'DEBUG_LOG' && m.tag === 'pipeline.cs_rescan_received');
  check('ARM rescan', rescanLog.length === 1 && rescanLog[0].data?.reason === 'probe_rescan'
    && rescanLog[0].data?.from_cache === true, JSON.stringify(rescanLog));
  await waitForBadges(page, { min: 1 });
  await settle(800);

  // resolve_reference — a saved reference, seeded into storage so the
  // probe does not have to activate an element to create one. The target is
  // the fixture's `add iframe` button: clicking it puts a node in the DOM,
  // which is the observable, and it also makes the element last-activated,
  // which is what probe 25 needs.
  await sw.evaluate(async (host) => {
    await chrome.storage.local.set({
      branchkit_references: {
        [host]: {
          references: {
            probetarget: {
              selector: '#add-iframe', tag: 'button',
              createdAt: Date.now(), lastUsedAt: Date.now(), visibleText: 'add iframe',
            },
          },
          marks: {},
        },
      },
    });
  }, new URL(url).hostname);
  await page.evaluate(() => document.getElementById('child')?.remove());
  await act('resolve_reference', { name: 'probetarget' });
  await settle(1200);
  const iframeAppeared = await page.evaluate(() => !!document.getElementById('child'));
  check('ARM resolve_reference', iframeAppeared, `#child present=${iframeAppeared}`);

  // name_reference — names the element resolve_reference just activated,
  // and tells the SW about it. Both halves are asserted: the stored entry and
  // the message, because the arm's whole job is the pair.
  await drain();
  await act('name_reference', { name: 'ProbeNamed' });
  await settle(1200);
  const savedMsg = (await drain()).find((m) => m.type === 'REFERENCE_SAVED');
  const storedRefs = await sw.evaluate(async (host) => {
    const all = (await chrome.storage.local.get('branchkit_references')).branchkit_references ?? {};
    return Object.keys(all[host]?.references ?? {});
  }, new URL(url).hostname);
  check('ARM name_reference', storedRefs.includes('probenamed') && savedMsg?.name === 'probenamed',
    `stored=${JSON.stringify(storedRefs)} message=${JSON.stringify(savedMsg?.name)}`);
  await page.evaluate(() => document.getElementById('child')?.remove());
  await settle(500);

  // --- The two arms that did NOT move (section 6i) -------------------------
  //
  // `activate` and `reactivate` stayed in content.ts because they reach
  // preNavObserverTeardown and republishForActivation. Section 6i asked for a
  // probe per MOVED arm and got one; these two were never in that scope and so
  // ended up the only BRANCHKIT_ACTION arms with no coverage anywhere — this
  // file is the only thing in scripts/ that drives BRANCHKIT_ACTION at all.
  //
  // That gap is load-bearing for what comes next. The three-tier resolution
  // wiring is duplicated between content.ts's `activate` arm and
  // voice-dispatch's element verbs, and collapsing it is the queued commit.
  // Before these probes, the same one-line mutation (`resolveFromStore` made
  // to return undefined) was killed by six probes in voice-dispatch.ts and
  // survived tsc, four lint scripts, 2278 tests and four harness runs in
  // content.ts. A collapse would have been verified on one side only.

  await page.evaluate(() => {
    window.__clicked = [];
    document.addEventListener('click', (e) => {
      window.__clicked.push((e.target.textContent || '').trim());
    }, true);
  });
  await waitForBadges(page, { min: 1 });
  await settle(700);
  // Re-resolve: the reference arms above added and removed an iframe, so the
  // codeword-to-element map from before them cannot be trusted here.
  const byNameNow = new Map();
  for (const cw of await badgeText()) {
    const r = await send({ type: 'RESOLVE_HINT', codeword: cw }, { frameId: 0 });
    if (r && r.ok && r.accessibleName) byNameNow.set(r.accessibleName, { cw, ...r });
  }
  const actT = byNameNow.get('epsilon');

  // activate — the whole point is WHICH tier resolved it. `resolution` is the
  // discriminator the element-verb probes rely on too, and it is the field a
  // broken wiring changes first: a dead live-store tier reports 'none' and
  // clicks nothing. The page-world click is the half that can only be true if
  // activateElement actually ran. `epsilon` is used by no other probe.
  await drain();
  await act('activate', { codeword: actT?.cw ?? '__unresolvable__' });
  await settle(1000);
  const actR = await lastDispatch('activate');
  const clicked = await page.evaluate(() => window.__clicked);
  check('ARM activate',
    clicked.includes('epsilon') && actR?.ok === true
    && actR.elem_tag === 'button' && actR.resolution === 'live_store',
    `clicked=${JSON.stringify(clicked)} report=${JSON.stringify(actR)}`);

  // The sealed strict gate (activate/sealed-gate.ts), which this arc moved to
  // a leaf and which had NO coverage at either call site: no probe set
  // `prefix_letter`, the marker that arms it, so `sealedDispatchSeen` could be
  // replaced by `return true` — clicking blind on off-screen, CSS-hidden and
  // occluded targets — with every gate green.
  //
  // `detail` is the discriminator and the reason this asserts the string
  // rather than just ok=false: BOTH the gate's refusal and an ordinary
  // unresolved target report ok=false/skipped, and only the gate writes
  // 'no_such_hint'. A defeated gate falls through to the unresolved-target
  // branch and says 'activate target not resolved' instead.
  await drain();
  await act('activate',
    { codeword: '__unresolvable__', prefix_letter: 'z', suffix_letter: 'q' });
  await settle(800);
  const sealedR = await lastDispatch('activate');
  check('ARM activate refuses a sealed miss',
    sealedR?.ok === false && sealedR.taken === 'skipped'
    && sealedR.detail === 'no_such_hint',
    JSON.stringify(sealedR));

  // The gate's OTHER half, and it needs its own probe: the one above resolves
  // to nothing, so it only exercises `sealedDispatchSeen`'s not-an-element
  // guard. A mutant that kept that guard and defeated the live checks
  // (`return true` in place of the on-screen / CSS-visible / not-occluded
  // conjunction — i.e. clicking blind on exactly the targets the rule exists
  // to refuse) passed the probe above. Measured, not supposed.
  //
  // Occlusion is the case to drive. Scrolling the target out of view was the
  // first attempt and does not work: the band re-assigns on scroll, so the
  // codeword stops resolving and the refusal comes from the not-an-element
  // guard again. An overlay leaves the target itself untouched and in the
  // band — only `isOccludedLive` changes.
  //
  // `resolution` is what makes this airtight, and it is why no separate
  // RESOLVE_HINT witness is needed. reportNoSuchHint echoes the resolution it
  // was given, so a gate refusing a RESOLVED element says 'live_store' while
  // a refusal over nothing says 'none'. Asserting 'live_store' means a run
  // where the wrapper was dropped fails loudly instead of passing for the
  // wrong reason — the failure mode that killed the scroll version.
  const occT = byNameNow.get('alpha');
  await page.evaluate(() => {
    const o = document.createElement('div');
    o.id = '__probe_overlay__';
    // Under the badge layer (2147483645) so badges still paint, over the page
    // so the occlusion read hits this instead of the button.
    o.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483000';
    document.body.appendChild(o);
  });
  await settle(900);
  await drain();
  await act('activate',
    { codeword: occT?.cw ?? '__unresolvable__', prefix_letter: 'z', suffix_letter: 'q' });
  await settle(800);
  const occR = await lastDispatch('activate');
  const clickedAfterOcclusion = await page.evaluate(() => window.__clicked);
  check('ARM activate refuses an occluded sealed target',
    occR?.ok === false && occR.taken === 'skipped' && occR.detail === 'no_such_hint'
    && occR.resolution === 'live_store' && !clickedAfterOcclusion.includes('alpha'),
    `report=${JSON.stringify(occR)} clicked=${JSON.stringify(clickedAfterOcclusion)}`);
  await page.evaluate(() => document.getElementById('__probe_overlay__')?.remove());
  await settle(700);

  // reactivate — republishForActivation rotates the put-queue session and
  // re-Puts every live codeword. The rotate is the observable: it names both
  // session ids, so a rotate that did not happen is not merely absent, it
  // cannot be faked by an arm that logged and did nothing.
  await waitForBadges(page, { min: 1 });
  await settle(700);
  await drain();
  await act('reactivate', { reason: 'probe_reactivate' });
  await settle(1200);
  const rotate = (await drain()).find(
    (m) => m.type === 'PLUGIN_DEBUG_LOG' && m.tag === 'BK_SESSION_ROTATE');
  check('ARM reactivate',
    !!rotate?.data?.from && !!rotate?.data?.to && rotate.data.from !== rotate.data.to,
    JSON.stringify(rotate ?? null));

  // The correlation scope, pinned rather than argued. setLogCorrelation runs
  // in content.ts's handler and self-clears on the next microtask, so every
  // arm below it has to sit inside that synchronous window for its bkLog
  // lines to join the matcher's tr_ chain in browser.log. Read off a log line
  // emitted from deep inside the arm, which is the only way to see it.
  //
  // It rides the same BK_SESSION_ROTATE line the probe above reads, so an arm
  // that stops republishing fails BOTH — read them together, the rotate one
  // names the cause.
  //
  // KNOWN BLIND SPOT, stated rather than papered over: this rides the
  // `reactivate` arm, which is in content.ts. It pins the shared precondition
  // — that setLogCorrelation still precedes the branch — and that is the
  // failure worth catching, because it breaks both sides at once. It does NOT
  // pin the moved side independently: if dispatchVoiceAction ever became
  // async, its arms would fall out of scope and this probe would stay green.
  // Closing that needs a bkLog reachable synchronously from a moved arm, and
  // today none of the fifteen has one (checked: badge-visibility,
  // holder-registry, escape-cascade, page-session and singletons emit none).
  check('BRANCHKIT_ACTION scopes the tr_',
    rotate?.data?.correlationId === 'tr_probe',
    `correlationId=${JSON.stringify(rotate?.data?.correlationId)}`);

  // --- The navigating arms go LAST: each one replaces the content script.

  // history_back / history_forward / refresh. The UI back button skips
  // voice-navigated SPA entries, which is why these route through a JS call —
  // so the probe is that the JS call happened, i.e. the document changed.
  await page.goto(`${url}/b.html`);
  await waitForBadges(page, { min: 1 });
  await settle(900);
  await act('history_back');
  await page.waitForURL(`${url}/a.html`, { timeout: 8000 }).catch(() => {});
  const backTo = page.url();
  await waitForBadges(page, { min: 1 });
  await settle(900);
  await act('history_forward');
  await page.waitForURL(`${url}/b.html`, { timeout: 8000 }).catch(() => {});
  const fwdTo = page.url();
  await waitForBadges(page, { min: 1 });
  await settle(900);
  // refresh: a page-world sentinel that only a real document load can clear.
  await page.evaluate(() => { window.__survivesReload = true; });
  await act('refresh');
  await page.waitForFunction(() => window.__survivesReload === undefined, undefined, { timeout: 8000 })
    .catch(() => {});
  const reloaded = await page.evaluate(() => window.__survivesReload === undefined);
  check('ARM history_back / history_forward / refresh',
    backTo === `${url}/a.html` && fwdTo === `${url}/b.html` && reloaded,
    `back->${backTo} forward->${fwdTo} refresh cleared sentinel=${reloaded}`);
} finally {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
  if (results.length < EXPECTED) {
    console.log(`\nONLY ${results.length}/${EXPECTED} PROBES RAN — the run aborted, this is NOT a pass`);
  } else {
    console.log(results.every((r) => r.ok)
      ? `\nALL ${EXPECTED} PROBES PASS`
      : `\n${results.filter((r) => !r.ok).length} PROBE FAILURE(S)`);
  }
  await ctx.close();
  fixture.server.close();
}
