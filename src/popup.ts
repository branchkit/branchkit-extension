/**
 * BranchKit Browser — Popup.
 *
 * Two surfaces in one popup:
 *   1. Existing global settings (status, hints visibility, label mode).
 *   2. Per-site rule editor (matched against the active tab's URL).
 *
 * The popup is the "fix THIS site" surface — options.html is for
 * cross-site browsing. CSS matchers only here; text/class matchers
 * stay in the options page where there's room for the UI to breathe.
 */

import {
  urlMatchesPattern,
  type DomainRule,
  type RuleEntry,
  type RevealMethod,
} from './rules/domain-rules';
import { loadDomainRules, saveDomainRules } from './rules/domain-rules-storage';
import { getRuleForPattern, setRuleOff, setRulePassKeys } from './keyboard-rules';
import { migrateDisplayMode } from './labels/words';
import { suggestPattern, isValidSelector } from './rules/options-helpers';
import {
  KIND_META,
  matcherSummary,
  nudgeSummary,
  resolveCodewordFromTab,
  renderResolvePreview,
  setFeedbackError,
  clearFeedback,
} from './rules/rule-ui';

// --- State ---

let activeTab: chrome.tabs.Tab | null = null;
let rules: DomainRule[] = [];

// A rule just created by a "create/add rule" button is a draft: it lives
// in `rules` for rendering but is NOT persisted until it has at least one
// entry. So clicking a create button and then closing the popup (or never
// adding anything) leaves storage untouched — the empty rule evaporates
// instead of lingering. Cleared once the draft gains an entry.
let draftRuleId: string | null = null;

// --- Global settings (existing) ---

// The origin the background needs for discovery + SSE to the BranchKit host.
// Firefox MV3 treats manifest host permissions as opt-in: on a fresh install
// this origin is NOT granted, every discovery fetch dies silently on CORS,
// and the extension impersonates a healthy standalone setup (hints paint,
// voice never connects). The about:addons Permissions tab doesn't reliably
// show for temporary add-ons, so this popup is the one guaranteed surface
// that can name the problem and fix it (permissions.request needs a user
// gesture — the button click qualifies). Chrome grants host permissions at
// install, so the blocked state never shows there.
const HOST_ORIGIN = 'http://127.0.0.1/*';

// The Voice row has two faces: the interactive On/Paused control (connected or
// paused) and a read-only "Off" (BranchKit not detected — nothing to pause,
// voice just isn't available). Once we've shown the interactive control this
// popup open, keep showing it — a resume's brief connecting gap reports
// not-detected transiently, and downgrading to "Off" under the cursor would
// flicker. The popup is ephemeral, so "sticky for this open" is the whole scope.
let voiceInteractive = false;

// Show the interactive On/Paused control (BranchKit connected or paused).
function showVoiceInteractive(paused: boolean): void {
  document.getElementById('voice-pause-setting')!.hidden = false;
  document.getElementById('voice-pause')!.hidden = false;
  document.getElementById('voice-off')!.hidden = true;
  voiceInteractive = true;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#voice-pause .seg')) {
    const active = (b.dataset.value === 'off') === paused;
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', String(active));
  }
}

// Show the read-only Off (BranchKit not detected — nothing to pause).
function showVoiceOff(): void {
  document.getElementById('voice-pause-setting')!.hidden = false;
  document.getElementById('voice-pause')!.hidden = true;
  document.getElementById('voice-off')!.hidden = false;
}

async function checkStatus(): Promise<void> {
  const dot = document.getElementById('dot')!;
  const text = document.getElementById('status-text')!;
  const grantBtn = document.getElementById('grant-access') as HTMLButtonElement | null;
  if (grantBtn) grantBtn.hidden = true;

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_HEALTH' });
    if (resp?.paused) {
      // Paused by choice — an explicit state, never "not detected".
      dot.className = 'dot paused';
      text.textContent = 'Voice paused';
      showVoiceInteractive(true);
      return;
    }
    if (resp?.branchkit) {
      dot.className = 'dot connected';
      text.textContent = 'Connected to BranchKit';
      showVoiceInteractive(false);
      return;
    }
    // Standalone: nothing to pause — show the read-only Off. But if we've
    // already shown the interactive control this open (e.g. a resume in
    // progress reporting not-detected transiently), keep it to avoid flicker.
    dot.className = 'dot disconnected';
    if (!voiceInteractive) showVoiceOff();
    let hasHostAccess = true;
    try {
      hasHostAccess = await chrome.permissions.contains({ origins: [HOST_ORIGIN] });
    } catch { /* permissions API unavailable — report the generic state */ }
    if (!hasHostAccess && grantBtn) {
      text.textContent = 'Browser is blocking the BranchKit connection';
      grantBtn.hidden = false;
    } else {
      text.textContent = 'BranchKit not detected';
    }
  } catch {
    dot.className = 'dot disconnected';
    text.textContent = 'Extension error';
  }
}

// The voice On/Paused toggle. Unlike the sync-key segmented controls, this
// drives the SW's pause lifecycle (SET_VOICE_PAUSED) — which tears down /
// re-establishes the connection — and the SW owns the persisted flag. Poll
// checkStatus after so the dot/text settle once the stream comes up (resume)
// or the teardown lands (pause), mirroring the grant button's poll.
function initVoicePauseToggle(): void {
  const text = document.getElementById('status-text')!;
  // Scope to the interactive control only — the read-only Off segment is
  // `disabled` and lives in a separate container.
  for (const b of document.querySelectorAll<HTMLButtonElement>('#voice-pause .seg')) {
    b.addEventListener('click', async () => {
      const paused = b.dataset.value === 'off';
      showVoiceInteractive(paused);          // optimistic
      text.textContent = paused ? 'Pausing…' : 'Connecting…';
      try {
        await chrome.runtime.sendMessage({ type: 'SET_VOICE_PAUSED', paused });
      } catch { /* SW asleep/among reloads — the poll below re-reads truth */ }
      checkStatus();
      setTimeout(checkStatus, 1_200);
    });
  }
}

function initGrantButton(): void {
  const btn = document.getElementById('grant-access') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const text = document.getElementById('status-text')!;
    let granted = false;
    try {
      // Must be called directly from the click handler (user gesture).
      granted = await chrome.permissions.request({ origins: [HOST_ORIGIN] });
    } catch {
      granted = false;
    }
    if (!granted) return; // user dismissed the browser dialog — leave the button up
    btn.hidden = true;
    text.textContent = 'Connecting…';
    // The background's permissions.onAdded listener connects immediately;
    // poll a couple of times so the dot flips while the popup is still open.
    setTimeout(checkStatus, 1_000);
    setTimeout(checkStatus, 3_000);
  });
}

// Segmented pill control bound to a string-valued sync key. The buttons carry
// the stored value in `data-value`; the `.active` one in markup is the default
// shown until storage loads (mirrors the old <select>'s first-option default).
function initSyncedSegmented(
  id: string,
  storageKey: string,
  migrate?: (v: unknown) => string,
): void {
  const group = document.getElementById(id)!;
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('.seg'));
  const select = (value: string) => {
    for (const b of buttons) {
      const on = b.dataset.value === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  chrome.storage.sync.get(storageKey, (result) => {
    const raw = result[storageKey];
    if (raw === undefined) return; // markup default (.active) stands
    const value = migrate ? migrate(raw) : String(raw);
    select(value);
    // Persist the migrated value once so a legacy stored value doesn't leave
    // every pill inactive on the next open.
    if (migrate && value !== raw) chrome.storage.sync.set({ [storageKey]: value });
  });
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const value = b.dataset.value!;
      select(value);
      chrome.storage.sync.set({ [storageKey]: value });
    });
  }
}

// Segmented On/Off bound to a boolean-valued sync key (data-value "on"/"off").
function initSyncedSegmentedBool(id: string, storageKey: string, defaultOn = false): void {
  const group = document.getElementById(id)!;
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('.seg'));
  const select = (on: boolean) => {
    for (const b of buttons) {
      const active = (b.dataset.value === 'on') === on;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    }
  };
  chrome.storage.sync.get(storageKey, (result) => {
    // defaultOn keys are on unless explicitly stored false (absent → on).
    select(defaultOn ? result[storageKey] !== false : result[storageKey] === true);
  });
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const on = b.dataset.value === 'on';
      select(on);
      chrome.storage.sync.set({ [storageKey]: on });
    });
  }
}

// Live "this page" readout — asks the active tab's content script how many
// hint candidates it's tracking and whether badges are painted. Stays hidden
// on pages with no content script (chrome://, the web store, not-yet-injected).
async function initPageReadout(): Promise<void> {
  const wrap = document.getElementById('readout')!;
  const dot = document.getElementById('readout-dot')!;
  const text = document.getElementById('readout-text')!;
  if (!activeTab?.id) return;

  let status: { hintCount: number; badgesVisible: boolean } | undefined;
  try {
    status = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_PAGE_STATUS' });
  } catch {
    return; // no content script on this page — leave the readout hidden
  }
  if (!status) return;

  const { hintCount, badgesVisible } = status;
  const on = badgesVisible && hintCount > 0;
  dot.className = on ? 'readout-dot on' : 'readout-dot';

  const toggle = document.getElementById('readout-toggle') as HTMLButtonElement;
  if (hintCount === 0) {
    // Nothing to show or hide on this page — the button would be a no-op.
    text.textContent = 'No badges on this page';
    toggle.hidden = true;
  } else {
    const noun = hintCount === 1 ? 'badge' : 'badges';
    const state = badgesVisible ? 'Showing' : 'Hidden';
    text.replaceChildren(
      document.createTextNode(`${state} · `),
      Object.assign(document.createElement('span'), {
        className: 'readout-count',
        textContent: String(hintCount),
      }),
      document.createTextNode(` ${noun} on this page`),
    );
    // The UI twin of Shift+F: label names the action (the opposite of now).
    pageBadgesVisible = badgesVisible;
    toggle.textContent = badgesVisible ? 'Hide' : 'Show';
    toggle.hidden = false;
  }
  wrap.hidden = false;
}

// Last-read badge visibility of the active tab, so the Show/Hide click sends a
// definite target (the opposite) without re-querying first.
let pageBadgesVisible = false;

// Wire the readout's Show/Hide button once. Momentary — same as Shift+F: hiding
// in always mode lasts for this page (nav/reload repaints), so this is a
// "right now, this page" control, not a preference.
function initReadoutToggle(): void {
  const toggle = document.getElementById('readout-toggle') as HTMLButtonElement | null;
  if (!toggle) return;
  toggle.addEventListener('click', async () => {
    if (!activeTab?.id) return;
    const target = !pageBadgesVisible;
    toggle.disabled = true;
    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'SET_BADGES_VISIBLE', visible: target });
    } catch {
      // No content script on this page — nothing to toggle.
    }
    toggle.disabled = false;
    await initPageReadout(); // re-read to resync label + dot with the result
  });
}

function initOptionsLink(): void {
  const btn = document.getElementById('open-options');
  if (btn) {
    btn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  }

  // Help: open the shortcuts/help overlay on the active tab (same as ? / "help"),
  // then close the popup so the overlay is visible on the page.
  const help = document.getElementById('open-help');
  help?.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) {
        await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_HELP' }, { frameId: 0 }).catch(() => {});
      }
    } finally {
      window.close();
    }
  });
}

// --- Per-site rules ---

async function loadRules(): Promise<void> {
  rules = await loadDomainRules();
}

function saveRules(): void {
  // A draft that has gained an entry graduates to a real, persisted rule.
  if (draftRuleId !== null) {
    const draft = rules.find((r) => r.id === draftRuleId);
    if (!draft || draft.entries.length > 0) draftRuleId = null;
  }
  // Never write an empty draft to storage.
  const toPersist = draftRuleId !== null
    ? rules.filter((r) => r.id !== draftRuleId)
    : rules;
  saveDomainRules(toPersist);
}

function activeHost(): string {
  if (!activeTab?.url) return '';
  try { return new URL(activeTab.url).host; } catch { return ''; }
}

// Hostname (no port) — matches `location.hostname` in the content script, the
// key used for per-site keyboard exclusions.
function activeHostname(): string {
  if (!activeTab?.url) return '';
  try { return new URL(activeTab.url).hostname; } catch { return ''; }
}

// "Shortcuts here" On/Off — per-site keyboard exclusion. On = BranchKit's keys
// active; Off = handed to the page. Hidden on pages with no host (chrome://).
// The popup's quick control edits the keyboard rule for the CURRENT site's
// exact hostname (a shortcut for the common "fix this site now" case). Broader
// patterns are managed on the options page. See notes/DESIGN_PASS_THROUGH.md.
function initShortcutsToggle(): void {
  const url = activeTab?.url ?? '';
  // The quick control targets the whole-domain pattern (*.wikipedia.org), the
  // same suggestion the badge rules offer — not just this exact subdomain.
  const pattern = url ? suggestPattern(url) : null;
  if (!pattern) {
    document.getElementById('key-rules-section')?.setAttribute('hidden', '');
    return;
  }
  // Header names the host you're on (like the badge rules), while the create
  // button names the broader pattern the rule will cover.
  const keyHostEl = document.getElementById('key-rules-host');
  if (keyHostEl) keyHostEl.textContent = activeHost() || pattern;

  const seg = document.getElementById('key-disable-all');
  const buttons = seg ? Array.from(seg.querySelectorAll<HTMLButtonElement>('.seg')) : [];
  const passInput = document.getElementById('key-passthrough') as HTMLInputElement | null;

  // A key rule is one object per pattern ({off, passKeys}), so — like the badge
  // rules — the controls stay collapsed behind a "+ Create rule" button until
  // there's a rule to edit. An existing rule shows its controls straight away.
  const empty = document.getElementById('key-rule-empty');
  const controls = document.getElementById('key-rule-controls');
  const createBtn = document.getElementById('key-create-rule');
  if (createBtn) createBtn.textContent = '+ Create rule for ' + pattern;
  const showControls = (show: boolean): void => {
    controls?.toggleAttribute('hidden', !show);
    empty?.toggleAttribute('hidden', show);
  };
  createBtn?.addEventListener('click', () => {
    showControls(true);
    passInput?.focus();
  });

  // "Disable all" is the whole-site off switch; the pass-keys field is the
  // granular list. When everything's disabled, per-key is moot — grey it out.
  const reflectOff = (off: boolean): void => {
    for (const b of buttons) {
      const active = (b.dataset.value === 'on') === off;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    }
    if (passInput) passInput.disabled = off;
  };

  void getRuleForPattern(pattern).then((rule) => {
    // A persisted rule always carries off or passKeys (empty ones are dropped
    // on save), so its mere presence means "show the controls".
    showControls(!!rule);
    reflectOff(!!rule?.off);
    if (passInput) passInput.value = rule?.passKeys ?? '';
  });

  for (const b of buttons) {
    b.addEventListener('click', () => {
      const off = b.dataset.value === 'on'; // "Disable all: On" == shortcuts off
      reflectOff(off);
      void setRuleOff(pattern, off);
    });
  }

  // Pass-through keys: each typed character is one key handed to the site.
  passInput?.addEventListener('input', () => {
    void setRulePassKeys(pattern, passInput.value);
  });
}

// Every rule whose pattern matches the active tab, enabled or not, so a
// disabled rule still shows (greyed) and can be re-enabled from here. The
// cascade — which rules actually apply — filters enabled in content.ts.
function activeRules(): DomainRule[] {
  if (!activeTab?.url) return [];
  const url = activeTab.url;
  return rules.filter((r) => urlMatchesPattern(url, r.pattern));
}

function render(): void {
  const hostEl = document.getElementById('rules-host')!;
  const bodyEl = document.getElementById('rules-body')!;
  const host = activeHost();

  if (!host) {
    hostEl.textContent = 'this page';
    bodyEl.replaceChildren(noRuleNode('Rules apply to http(s) sites only.'));
    return;
  }
  hostEl.textContent = host;

  const matched = activeRules();
  if (matched.length === 0) {
    bodyEl.replaceChildren(noRuleNode());
    return;
  }
  const nodes: Node[] = matched.map(renderRuleCard);
  const addSpecific = addSpecificRuleNode();
  if (addSpecific) nodes.push(addSpecific);
  bodyEl.replaceChildren(...nodes);
}

// When a broader rule (e.g. *.quickbase.com) already matches, offer a
// one-click way to add a rule scoped to this exact host — the realm-
// specific override that otherwise required the options page. Hidden
// once such a rule exists. Returns null when there's no usable hostname.
function addSpecificRuleNode(): HTMLElement | null {
  if (!activeTab?.url) return null;
  let host: string;
  try { host = new URL(activeTab.url).hostname; } catch { return null; }
  if (!host) return null;
  if (rules.some((r) => r.pattern === host)) return null;

  const row = document.createElement('div');
  row.className = 'add-rule-row';
  const btn = document.createElement('button');
  btn.textContent = `+ Add rule for ${host}`;
  btn.title = `Create a rule that applies only to ${host}`;
  btn.addEventListener('click', () => {
    const fresh: DomainRule = {
      id: crypto.randomUUID(),
      pattern: host,
      enabled: true,
      entries: [],
    };
    draftRuleId = fresh.id;
    rules = [fresh, ...rules];
    render();  // draft — persisted once it gets its first entry
  });
  row.appendChild(btn);
  return row;
}

function noRuleNode(message?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'no-rule';

  if (message) {
    wrap.textContent = message;
    return wrap;
  }

  const suggested = activeTab?.url ? suggestPattern(activeTab.url) : null;
  if (!suggested) {
    wrap.textContent = 'No rule for this site.';
    return wrap;
  }

  // Header already names the host you're on; the button names the pattern the
  // rule will cover. No standalone pattern line — it just duplicated the button.
  wrap.append('No rule for this site.');

  const btn = document.createElement('button');
  btn.textContent = `+ Create rule for ${suggested}`;
  btn.addEventListener('click', () => {
    const fresh: DomainRule = {
      id: crypto.randomUUID(),
      pattern: suggested,
      enabled: true,
      entries: [],
    };
    draftRuleId = fresh.id;
    rules = [fresh, ...rules];
    render();  // draft — persisted once it gets its first entry
  });
  wrap.appendChild(btn);
  return wrap;
}

function renderRuleCard(rule: DomainRule): HTMLElement {
  const card = document.createElement('div');
  card.className = 'rule-card';
  if (!rule.enabled) card.classList.add('disabled');

  const headerRow = document.createElement('div');
  headerRow.className = 'rule-row';

  const pattern = document.createElement('span');
  pattern.className = 'rule-pattern';
  pattern.textContent = rule.pattern;
  pattern.title = rule.pattern;
  headerRow.appendChild(pattern);

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = rule.enabled;
  toggle.title = 'Enable/disable rule';
  toggle.addEventListener('change', () => {
    rule.enabled = toggle.checked;
    saveRules();
    card.classList.toggle('disabled', !rule.enabled);
  });
  headerRow.appendChild(toggle);

  card.appendChild(headerRow);

  const entriesEl = document.createElement('div');
  entriesEl.className = 'entries-list';
  renderEntries(rule, entriesEl);
  card.appendChild(entriesEl);

  card.appendChild(renderAddEntry(rule, entriesEl));
  return card;
}

function renderEntries(rule: DomainRule, container: HTMLElement): void {
  container.replaceChildren();
  for (const entry of rule.entries) {
    container.appendChild(renderEntry(rule, entry, container));
  }
}

function renderEntry(rule: DomainRule, entry: RuleEntry, entriesEl: HTMLElement): HTMLElement {
  const node = document.createElement('div');
  node.className = 'entry';
  if (entry.enabled === false) node.classList.add('entry-off');

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'entry-toggle';
  toggle.checked = entry.enabled !== false;
  toggle.title = 'Apply this entry';
  toggle.addEventListener('change', () => {
    entry.enabled = toggle.checked;
    saveRules();
    node.classList.toggle('entry-off', !toggle.checked);
  });
  node.appendChild(toggle);

  const kind = document.createElement('span');
  kind.className = `entry-kind ${entry.kind}`;
  kind.textContent = KIND_META[entry.kind].glyph;
  kind.title = entry.kind
    + (entry.reveal ? ` (${entry.reveal})` : '')
    + (entry.nudge ? ` ${nudgeSummary(entry)}` : '');
  node.appendChild(kind);

  const text = document.createElement('span');
  text.className = 'entry-text';
  let summary = matcherSummary(entry.matcher);
  if (entry.nudge) summary += ` ${nudgeSummary(entry)}`;
  text.textContent = entry.label ? `${entry.label} — ${summary}` : summary;
  text.title = summary;
  node.appendChild(text);

  const remove = document.createElement('button');
  remove.className = 'entry-remove';
  remove.textContent = '×';
  remove.title = 'Remove entry';
  remove.addEventListener('click', () => {
    rule.entries = rule.entries.filter(e => e.id !== entry.id);
    saveRules();
    renderEntries(rule, entriesEl);
  });
  node.appendChild(remove);

  return node;
}

function renderAddEntry(rule: DomainRule, entriesEl: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'add-entry';

  // Row 1: kind picker + reveal method + matcher input + Add
  const row1 = document.createElement('div');
  row1.className = 'add-entry-row';

  const kindSelect = document.createElement('select');
  kindSelect.title = 'Entry kind';
  for (const [val, lbl] of [['exclude', 'Exclude'], ['include', 'Include'], ['reveal', 'Reveal'], ['nudge', 'Nudge']] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    kindSelect.appendChild(opt);
  }
  row1.appendChild(kindSelect);

  const revealSelect = document.createElement('select');
  revealSelect.title = 'Reveal method';
  revealSelect.hidden = true;
  for (const [val, lbl] of [['opacity', 'Opacity'], ['visibility', 'Visibility']] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    revealSelect.appendChild(opt);
  }
  row1.appendChild(revealSelect);

  const nudgeX = document.createElement('input');
  nudgeX.type = 'number';
  nudgeX.className = 'nudge-px';
  nudgeX.placeholder = 'x px';
  nudgeX.title = 'Horizontal offset in pixels (negative = left)';
  nudgeX.step = '1';
  nudgeX.hidden = true;
  row1.appendChild(nudgeX);

  const nudgeY = document.createElement('input');
  nudgeY.type = 'number';
  nudgeY.className = 'nudge-px';
  nudgeY.placeholder = 'y px';
  nudgeY.title = 'Vertical offset in pixels (negative = up)';
  nudgeY.step = '1';
  nudgeY.hidden = true;
  row1.appendChild(nudgeY);

  const matcherInput = document.createElement('input');
  matcherInput.type = 'text';
  matcherInput.className = 'matcher';
  matcherInput.placeholder = 'CSS selector';
  matcherInput.spellcheck = false;
  row1.appendChild(matcherInput);

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'entry-label';
  labelInput.placeholder = 'Label (optional)';
  labelInput.spellcheck = false;
  row1.appendChild(labelInput);

  const addBtn = document.createElement('button');
  addBtn.className = 'primary';
  addBtn.textContent = 'Add';
  row1.appendChild(addBtn);

  wrap.appendChild(row1);

  // Row 2: resolve from active tab
  const row2 = document.createElement('div');
  row2.className = 'add-entry-row resolve-row';
  const resolveLabel = document.createElement('label');
  resolveLabel.textContent = 'Pick:';
  row2.appendChild(resolveLabel);

  const codewordInput = document.createElement('input');
  codewordInput.type = 'text';
  codewordInput.className = 'codeword';
  codewordInput.placeholder = 'label shown on the badge';
  codewordInput.spellcheck = false;
  row2.appendChild(codewordInput);

  const resolveBtn = document.createElement('button');
  resolveBtn.className = 'secondary';
  resolveBtn.textContent = 'Resolve';
  row2.appendChild(resolveBtn);

  wrap.appendChild(row2);

  const feedback = document.createElement('div');
  feedback.className = 'feedback';
  wrap.appendChild(feedback);

  kindSelect.addEventListener('change', () => {
    revealSelect.hidden = kindSelect.value !== 'reveal';
    nudgeX.hidden = nudgeY.hidden = kindSelect.value !== 'nudge';
  });

  matcherInput.addEventListener('input', () => {
    matcherInput.classList.remove('invalid');
    clearFeedback(feedback);
  });

  addBtn.addEventListener('click', () => {
    const selector = matcherInput.value.trim();
    if (!selector) {
      matcherInput.classList.add('invalid');
      setFeedbackError(feedback, 'Selector is required.');
      return;
    }
    if (!isValidSelector(selector)) {
      matcherInput.classList.add('invalid');
      setFeedbackError(feedback, 'Invalid CSS selector.');
      return;
    }
    const kind = kindSelect.value as RuleEntry['kind'];
    const entry: RuleEntry = {
      id: crypto.randomUUID(),
      kind,
      matcher: { type: 'css', selector },
      label: labelInput.value.trim() || undefined,
    };
    if (kind === 'reveal') {
      entry.reveal = revealSelect.value as RevealMethod;
    }
    if (kind === 'nudge') {
      const dx = parseFloat(nudgeX.value);
      const dy = parseFloat(nudgeY.value);
      if (!Number.isFinite(dx) && !Number.isFinite(dy)) {
        setFeedbackError(feedback, 'Enter an x or y offset in pixels.');
        return;
      }
      entry.nudge = {
        dx: Number.isFinite(dx) ? dx : 0,
        dy: Number.isFinite(dy) ? dy : 0,
      };
    }
    rule.entries.push(entry);
    saveRules();
    matcherInput.value = '';
    labelInput.value = '';
    nudgeX.value = '';
    nudgeY.value = '';
    clearFeedback(feedback);
    renderEntries(rule, entriesEl);
  });

  resolveBtn.addEventListener('click', async () => {
    const codeword = codewordInput.value.trim();
    if (!codeword) {
      setFeedbackError(feedback, 'Type the badge label first.');
      return;
    }
    // Re-query the active tab so a tab-switch mid-popup doesn't target stale state.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      setFeedbackError(feedback, 'No active tab.');
      return;
    }
    activeTab = tab;
    clearFeedback(feedback);
    feedback.textContent = 'Resolving…';
    resolveBtn.disabled = true;
    const response = await resolveCodewordFromTab(tab.id, codeword);
    resolveBtn.disabled = false;
    if (!response.ok) {
      setFeedbackError(feedback, response.reason);
      return;
    }
    matcherInput.value = response.selector;
    matcherInput.classList.remove('invalid');
    codewordInput.value = '';
    renderResolvePreview(feedback, response);
    matcherInput.focus();
  });

  return wrap;
}

// --- Init ---

async function init(): Promise<void> {
  checkStatus();
  initGrantButton();
  initVoicePauseToggle();
  initSyncedSegmented('hint-visibility', 'hintVisibility');
  initSyncedSegmented('hint-mode', 'badgeDisplayMode', migrateDisplayMode);
  initSyncedSegmentedBool('tab-markers', 'tabMarkersEnabled', true);
  initOptionsLink();

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTab = tab ?? null;
  initShortcutsToggle();
  initReadoutToggle();
  initPageReadout();
  await loadRules();
  render();
}

init();
