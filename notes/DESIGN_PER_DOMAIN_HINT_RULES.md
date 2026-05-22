# Per-Domain Hint Rules

User-defined rules that exclude, include, or reveal elements on specific
domains. Applied at scan time so excluded elements never receive badges
and revealed elements become visible to the scanner.

## Problem

The hint system applies the same scanning logic everywhere.
`HINTABLE_SELECTOR` + `EXCLUDE_SELECTOR` + `isVisible` + `isRedundant`
are universal. The adapter system (`src/adapters/`) allows site-specific
overrides, but adapters are hardcoded and ship in the bundle.

Users need to:

- Exclude elements that clutter the badge layer (toolbar icons, breadcrumb
  nav links, decorative tabindex elements).
- Include elements the scanner misses (custom `[data-clickable]` widgets).
- Reveal hover-hidden elements that voice users can't reach (opacity:0
  buttons that only appear on mouse hover).

## Decisions

Resolved questions that shaped this design:

1. **Popup vs. options page.** Use an **options page** (`options.html`),
   not the popup. The popup is 260px wide with two dropdowns and a status
   dot. Domain rules need nested entry lists, codeword resolution, and
   element previews. That doesn't fit. The popup gets a link to the options
   page. The options page is vanilla HTML/JS — no framework.

2. **Multiple rules per domain.** Only one rule per domain pattern.
   Creating a second rule for `*.quickbase.com` when one exists opens the
   existing rule for editing. The UI makes this obvious by showing existing
   rules grouped by pattern.

3. **Seed rules delivery.** **No defaults ship.** Users who want a
   QuickBase or other site-specific rule add it themselves. Shipping
   pre-populated rules creates a maintenance burden (selectors break when
   sites change) and makes the extension's behavior feel less predictable
   to users who didn't ask for them. The data model carries no `builtin`
   flag and no "Default" badge — every rule is user-authored.

4. **`display` reveals.** **Defer to v2.** `opacity` and `visibility`
   reveals are safe (no layout shifts). `display: none -> revert` risks
   breaking page layout. The v1 data model includes the `RevealMethod`
   type with all three values so the schema doesn't need migration later,
   but the UI only exposes `opacity` and `visibility`. The `display`
   option is hidden behind a "Show advanced" toggle or omitted entirely.

5. **Reveal lifecycle: always-on vs. hints-active-only.** **Always-on.**
   Injecting and removing styles on hint toggle would cause visible
   flicker and orphan badges for elements that disappear mid-session. The
   reveal stylesheet is injected once on page load and stays. Users who
   find the always-visible elements distracting can disable individual
   reveal entries.

6. **Text/class matchers for includes.** **CSS-only for v1.** Include
   rules only accept CSS selectors. `querySelectorAll('*')` filtered by
   text content is too slow on large DOMs and the use case is rare (power
   users adding custom elements). Text and class matcher types remain in
   the data model for exclude rules where they filter an already-scanned
   list rather than querying the DOM.

7. **Named element references.** **Not in v1.** The data model doesn't
   pre-allocate `name` or `gate` fields. When command-gated hints
   (`DESIGN_COMMAND_GATED_HINTS.md`) ships, the two features will share
   a filter mechanism but the data models merge at that point, not now.
   Adding unused fields to "leave room" just creates confusion.

## Data Model

```typescript
interface DomainRules {
  rules: DomainRule[];
}

interface DomainRule {
  id: string;                  // crypto.randomUUID()
  pattern: string;             // "*.quickbase.com", "github.com"
  enabled: boolean;
  entries: RuleEntry[];
}

interface RuleEntry {
  id: string;
  kind: 'exclude' | 'include' | 'reveal';
  matcher: Matcher;
  reveal?: 'opacity' | 'visibility' | 'display';  // only for kind: 'reveal'
  label?: string;              // human-readable description ("Sidebar gears")
}

type Matcher =
  | { type: 'css'; selector: string }
  | { type: 'text'; value: string; caseSensitive: boolean }
  | { type: 'class'; name: string };
```

Constraints:
- `text` and `class` matchers are only valid for `kind: 'exclude'`.
- `include` entries must use `type: 'css'`.
- `reveal` entries must use `type: 'css'` (CSS injection requires a selector).

## Pattern Matching

Patterns match against `window.location.hostname` (not the full URL).

1. `*.example.com` — any subdomain. Matches `app.example.com`, not
   `example.com` itself.
2. `example.com` — exact host match.
3. `example.com/app/*` — host + path prefix. Matched against
   `hostname + pathname`.

Implementation is ~20 lines in `src/domain-rules.ts`. No glob library.

## Storage

`chrome.storage.sync` under key `domainRules`. Syncs across browsers.

```json
{
  "domainRules": {
    "rules": [
      {
        "id": "550e8400-...",
        "pattern": "*.quickbase.com",
        "enabled": true,
        "entries": [
          {
            "id": "6ba7b810-...",
            "kind": "exclude",
            "matcher": { "type": "css", "selector": "th.actionColumn[tabindex='0']" },
            "label": "Row-actions column header"
          }
        ]
      }
    ]
  }
}

```

Limits: 8KB per item, 100KB total. A rule is a few hundred bytes. Not a
concern for v1. If exceeded, `chrome.runtime.lastError` surfaces at write
time; the options page shows a save error.

## Rule Evaluation Pipeline

Order of operations at scan time:

```
0. Inject reveal styles  (CSS, pre-scan, modifies computed styles)
1. Generic scan           (HINTABLE_SELECTOR + isVisible + isRedundant)
2. Adapter exclusions     (adapter.exclude)
3. Adapter inclusions     (adapter.include)
4. Adapter category scans (adapter.categories)
5. User exclude rules     (domain-rules.ts)
6. User include rules     (domain-rules.ts, CSS-only)
```

### Module API

```typescript
// src/domain-rules.ts

// Find the first enabled rule matching this URL.
export function matchRule(url: string, rules: DomainRule[]): DomainRule | null;

// Inject a <style> element for reveal entries. Returns the element for
// later removal (on rule change). Must run before first doScan().
export function injectRevealStyles(rule: DomainRule): HTMLStyleElement | null;

// Filter scanned results by exclude entries. Mutates arrays in place.
export function applyExclusions(
  refs: Element[],
  elements: ScannedElement[],
  rule: DomainRule,
): void;

// Query DOM for include entries and return new elements to add.
export function collectInclusions(
  seen: Set<Element>,
  rule: DomainRule,
): { refs: Element[]; elements: ScannedElement[] };

// Check if a single element should be excluded. Used by isHintable
// callers (reevaluateAttribute, discoverInSubtree).
export function isExcludedByRule(el: Element, rule: DomainRule): boolean;
```

### Integration in content.ts

**On init** (before first `doScan()`):
1. Load rules from `chrome.storage.sync`.
2. Call `matchRule(location.href, rules)` and cache the result.
3. If the matched rule has reveal entries, call `injectRevealStyles()`.
4. Subscribe to `chrome.storage.onChanged` — on `domainRules` change,
   re-match, re-inject reveal styles (remove old `<style>` first via
   `[data-branchkit-reveal]`), and trigger `doScan()`.

**In `doScan()`:**
```typescript
const userRule = cachedUserRule;  // module-level, set on init
if (userRule) {
  applyExclusions(refs, elements, userRule);
  const extra = collectInclusions(seen, userRule);
  refs.push(...extra.refs);
  elements.push(...extra.elements);
}
```

**In `discoverInSubtree()` and `reevaluateAttribute()`:**
Pass the cached rule to `isExcludedByRule()` before creating wrappers.
This prevents MutationObserver-discovered elements from bypassing rules.

**Timing:** Rules load asynchronously. The first `doScan()` at the bottom
of `content.ts` fires immediately. If rules haven't loaded yet, that scan
runs without them. The `storage.onChanged` callback (or the initial load
callback) triggers a second `doScan()` with rules applied. The gap is
~10ms — a brief flash of extra badges on slow storage reads.

## Reveal Rules

Reveal rules inject page-level CSS that forces hover-hidden elements
visible. This is a genuine accessibility improvement — voice users can't
hover to reveal interactive elements.

### How sites hide elements

| Pattern | Scanner rejection | Reveal method | Layout risk |
|---------|-------------------|---------------|-------------|
| `opacity: 0` until parent `:hover` | `isVisible` rejects `opacity === '0'` | `opacity` | None |
| `visibility: hidden` until parent `:hover` | `isVisible` rejects | `visibility` | None |
| `display: none` until parent `:hover` | Zero dimensions | `display` (v2) | Layout shifts |

### Implementation

A single `<style data-branchkit-reveal>` element in `<head>`:

```css
button.settings-button { opacity: 1 !important; }
section.tableReportDropdown button { opacity: 1 !important; }
```

Built by iterating reveal entries and emitting one CSS rule per entry.
Injected once on page load, before the first scan. On rule change, the
old `<style>` is removed and a new one injected.

**Why CSS injection, not JS hover simulation:** `dispatchEvent` with
`MouseEvent` triggers JS handlers but does NOT activate the CSS `:hover`
pseudo-class. CSS injection is simpler, reliable, and side-effect-free.

## Options Page UI

### Layout

The options page (`options.html`) opens from a link in the popup. It has
one section: a rule list.

```
+--------------------------------------------------+
| Domain Rules                                      |
|                                                   |
| [+ Add rule for current site]                     |
|                                                   |
| *.quickbase.com  [on/off]  [edit] [delete]       |
|   - Exclude: th.actionColumn[tabindex="0"]        |
|   o Reveal:  button.settings-button (opacity)     |
|                                                   |
| github.com  [on/off]  [edit] [delete]             |
|   (no entries)                                     |
+--------------------------------------------------+

[-] = red, exclude     [+] = green, include     [o] = blue, reveal
```

### Key UX patterns (from Vimium/Rango research)

1. **Auto-generate pattern from active tab.** "Add rule for current
   site" reads `chrome.tabs.query({ active: true })`, extracts the
   eTLD+1, and pre-fills `*.domain.com`. The user never writes a pattern
   from scratch.

2. **Live validation.** A green/red dot next to each rule's pattern
   showing whether it matches the current tab's URL. Implemented by
   running `matchRule()` against the active tab URL on page load.

3. **Visual entry type indicators.** Red minus for excludes, green plus
   for includes, blue circle for reveals. Rango uses this pattern; it
   scales well as the entry list grows.

### Adding an entry

Two input modes, toggled by a radio:

**Codeword mode (default):** The user types a visible hint codeword
(e.g., "ape deck"). The options page sends a `RESOLVE_HINT` message to
the content script, which resolves codeword -> wrapper -> element and
returns a stable matcher + HTML preview. The user sees:

```
Resolve: [ape deck____]  [Resolve]

  Matched: <a class="deleteBtn">Delete</a>
  Selector: a.deleteBtn
  [Accept as exclude]  [Accept as include]  [Edit selector]
```

The codeword is throwaway — only the derived selector is saved.

**Manual mode:** A text field for a CSS selector (or text/class matcher
for excludes). Validated on input via `document.querySelector` in a
try/catch. Invalid selectors show a red border.

### Selector generation heuristics

When resolving a codeword to a stable selector, priority order:

1. `tag.className` — if 1-3 short, non-hash class names. Example:
   `a.deleteBtn`.
2. `[attribute="value"]` — semantic attributes (`data-action`,
   `aria-label`, `role`). Example: `a[aria-label="Delete"]`.
3. `#id` — if the id doesn't look generated (no UUIDs, no numeric
   suffixes). Ranked below class because many apps generate unstable ids.
4. Text content — last resort. Returns a `{ type: "text" }` matcher
   instead of CSS. Only valid for exclude entries.

The heuristics don't need to be perfect — the user sees the result and
can edit before saving.

## Example QuickBase Rules

Not shipped as defaults — kept here as reference for users (or for our
docs) who want to recreate the rules that motivated this feature. Add via
the options page.

**Exclusions:**

| Element | Matcher | Reason |
|---------|---------|--------|
| Row-actions column header | `th.actionColumn[tabindex="0"]` | Only `th` with `tabindex=0`; the checkbox inside already has its own badge. |

**Reveals (opacity):**

| Element | Matcher | Count | Description |
|---------|---------|-------|-------------|
| Sidebar table settings gears | `button.settings-button` | ~107 | Gear icon on each sidebar table link. |
| Column header menu buttons | `section.tableReportDropdown button` | ~20 | Sort/filter/hide column access. |
| App settings button | `button[aria-label="App settings"]` | 1 | Sidebar header gear. |

**Deferred (`display:none`, v2):**

| Element | Notes |
|---------|-------|
| Row-level action icons in `td.actionColumn` | Children are `display:none` until row hover. Forcing `display` risks layout shifts. |

## Files to Create or Modify

New files:
- `src/domain-rules.ts` — types, pattern matching, rule evaluation, reveal injection, `isExcludedByRule`.
- `src/domain-rules.test.ts` — unit tests for pattern matching, exclusion, inclusion.
- `options.html` — options page markup.
- `src/options.ts` — options page logic (vanilla JS).

Modified files:
- `src/content.ts` — load rules on init, wire into `doScan`, `discoverInSubtree`, `reevaluateAttribute`.
- `src/scanner.ts` — extend `isHintable` to accept optional rule parameter.
- `popup.html` — add link to options page.
- `manifest.json` — add `options_page` or `options_ui` entry, add `options.html` + `options.js` to build.

## Implementation Order

1. **`domain-rules.ts` + tests** — pure functions, no DOM dependencies
   beyond `document.querySelector` for validation. Fully testable.
2. **Wire into content.ts** — load from storage, cache, apply in scan
   pipeline. Test with hardcoded seed rules before UI exists.
3. **Reveal injection** — `injectRevealStyles` + lifecycle (init, rule
   change). Test on QuickBase with the known reveal selectors.
4. **Options page** — rule list, add/edit/delete, pattern auto-fill,
   live validation.
5. **Codeword resolution** — `RESOLVE_HINT` message, selector generation
   heuristics, preview in options page.
