# Per-Domain Hint Rules

User-defined rules that exclude, include, or reveal elements on specific
domains. Applied at scan time so excluded elements never receive badges
and revealed elements become visible to the scanner.

**Status:** Shipped. This doc describes the as-built design.

**Revised 2026-06-08:** Rule matching changed from first-match-only to
cascade — every enabled rule whose pattern matches the URL now
contributes. See Decision #2 and "Cascade Semantics".

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

1. **Popup *and* options page.** The popup is the primary per-site
   surface — it stays attached to the active tab, so "fix THIS site"
   flows feel direct. The options page is the cross-site browser for
   power users. An earlier draft called for options-only; the popup
   was added when testing revealed that bouncing to a separate tab
   broke the connection between rule editing and the page being fixed.

2. **Cascade: all matching rules merge.** Every enabled rule whose
   pattern matches the URL contributes. A general `*.quickbase.com`
   rule and a specific `acme.quickbase.com` rule both apply on
   `acme.quickbase.com` — their excludes, reveals, and includes are
   unioned. The popup lists every rule matching the active tab; the
   options page is the cross-site list. (This started as first-match-
   only, which silently dropped the more-specific override this very
   decision was meant to deliver. Fixed 2026-06-08.)

3. **Seed rules delivery.** **No defaults ship.** Users who want a
   QuickBase or other site-specific rule add it themselves. Shipping
   pre-populated rules creates a maintenance burden (selectors break
   when sites change) and feels unpredictable to users who didn't ask
   for them. No `builtin` flag on `DomainRule`; every rule is
   user-authored.

4. **`display` reveals.** **Deferred.** `opacity` and `visibility`
   reveals are safe (no layout shifts); reverting `display: none` to
   visible risks breaking page layout. The `RevealMethod` type carries
   all three values for forward compatibility, but the UI exposes only
   `opacity` and `visibility`. `injectRevealStyles` ignores `display`.

5. **Reveal lifecycle: always-on vs. hints-active-only.** **Always-on.**
   Injecting and removing styles on hint toggle would cause visible
   flicker and orphan badges for elements that disappear mid-session.
   The reveal stylesheet is injected once on page load and stays.
   Users who find the always-visible elements distracting can disable
   individual reveal entries.

6. **Text/class matchers for includes.** **CSS-only for v1.** Include
   rules only accept CSS selectors. `querySelectorAll('*')` filtered
   by text content is too slow on large DOMs and the use case is rare.
   Text and class matcher types remain in the data model for exclude
   rules where they filter an already-scanned list rather than
   querying the DOM.

7. **Codeword resolution lives in the popup and options page.** The
   popup resolves against the active tab implicitly (no tab picker).
   The options page has a tab picker so you can resolve from a
   different tab than the one you're configuring. Both flows reuse the
   existing `src/selector-generator.ts` (`generateSelector(el)`)
   instead of reimplementing the heuristics.

8. **Named element references.** **Not in v1.** The data model
   doesn't pre-allocate `name` or `gate` fields. When command-gated
   hints (`DESIGN_COMMAND_GATED_HINTS.md`) ships, the two features
   will share a filter mechanism but the data models merge at that
   point, not now.

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
  label?: string;              // human-readable description
}

type Matcher =
  | { type: 'css'; selector: string }
  | { type: 'text'; value: string; caseSensitive: boolean }
  | { type: 'class'; name: string };
```

Constraints:
- `text` and `class` matchers are only valid for `kind: 'exclude'`.
- `include` entries must use `type: 'css'`.
- `reveal` entries must use `type: 'css'`.

### CompiledRule

Scan-time path takes a `CompiledRule`, not a `DomainRule`. Compilation
buckets entries by kind, validates each include CSS selector, and joins
the valid ones into a single selector string so the runtime can use one
`querySelectorAll` per scan instead of N.

```typescript
interface CompiledRule {
  rules: DomainRule[];             // the matched set, in declaration order
  excludes: readonly RuleEntry[];
  reveals: readonly RuleEntry[];
  includeSelector: string | null;  // joined CSS, or null if no valid includes
}

function compileRules(matched: DomainRule[]): CompiledRule;
```

The content script holds one merged compiled rule (`compiledRule`) for
the frame's URL — the union of every matching rule. Recompilation
happens once per rule change.

## Pattern Matching

Patterns match against `window.location.hostname` (not the full URL).

1. `*.example.com` — any subdomain. Matches `app.example.com`, not
   `example.com` itself.
2. `example.com` — exact host match.
3. `example.com/app/*` — host + path prefix. Matched against
   `hostname + pathname`.

Implementation is ~20 lines in `src/domain-rules.ts`. No glob library.

## Cascade Semantics

`matchRules(url, rules)` returns every enabled rule whose pattern
matches, in declaration order. `compileRules(matched)` merges them into
one `CompiledRule`: excludes concatenate, reveals concatenate, and the
include selectors join into a single `querySelectorAll`.

The merge is a pure union — a rule can only ADD exclusions, reveals, or
includes; nothing subtracts. So the outcome is order-independent (union
is commutative) and there are no precedence conflicts to resolve. This
is why the model needs none of Vimium's passKey reconciliation: an
exclude is just "no badge", and two rules excluding overlapping sets is
identical to one rule excluding their union.

One deliberate nuance: includes run after excludes in the pipeline
(steps 5 then 6). A specific rule's `include` therefore re-adds an
element that a general rule's `exclude` removed — the only available
"override" gesture. It stays order-independent because
`collectInclusions` re-queries the DOM rather than reading the
post-exclude list.

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

Limits: 8KB per item, 100KB total. A rule is a few hundred bytes — not
a v1 concern.

## Rule Evaluation Pipeline

Order of operations at scan time:

```
0. Inject reveal styles  (CSS, once at rule load — modifies computed styles)
1. Generic scan           (HINTABLE_SELECTOR + isVisible + isRedundant)
2. Adapter exclusions     (adapter.exclude)
3. Adapter inclusions     (adapter.include)
4. Adapter category scans (adapter.categories)
5. User exclude rules     (domain-rules.ts, via CompiledRule.excludes)
6. User include rules     (domain-rules.ts, via CompiledRule.includeSelector)
```

### Module API

```typescript
// src/domain-rules.ts

// Every enabled rule matching this URL, in declaration order.
export function matchRules(url: string, rules: DomainRule[]): DomainRule[];

// Does one pattern match this URL? (options page per-row indicator.)
export function urlMatchesPattern(url: string, pattern: string): boolean;

// Merge the matched set: bucket entries + validate + join include
// selectors across all rules. Cache the result.
export function compileRules(matched: DomainRule[]): CompiledRule;

// Build a <style data-branchkit-reveal> from reveal entries. Caller
// inserts into <head>. Returns null when there are no usable reveals.
export function injectRevealStyles(reveals: readonly RuleEntry[]): HTMLStyleElement | null;

// Filter scanned results by exclude entries. Mutates arrays in place.
export function applyExclusions(
  refs: Element[],
  elements: ScannedElement[],
  excludes: readonly RuleEntry[],
): void;

// Query DOM via the joined include selector and return new elements.
export function collectInclusions(
  seen: Set<Element>,
  includeSelector: string | null,
  root?: ParentNode,
): { refs: Element[]; elements: ScannedElement[] };

// Single-element exclusion check for MutationObserver paths.
export function isExcludedByRule(el: Element, excludes: readonly RuleEntry[]): boolean;
```

### Integration in content.ts

**On init:**
1. Load rules from `chrome.storage.sync`.
2. Call `matchRules(location.href, rules)` and `compileRules()` on the
   matched set (skipped when nothing matches).
3. Inject reveal styles if any.
4. Run `doScan()` again (the boot-time scan ran before storage returned).

**On `chrome.storage.onChanged`:**
1. Re-match and compile.
2. Short-circuit if the matched rule *set* for this frame is
   structurally identical to the previous one — avoids the multi-tab
   stampede when the user edits a rule unrelated to this frame's URL.
3. Sweep previous `[data-branchkit-reveal]` stylesheets, inject the new one.
4. Detach wrappers that the new rule excludes; `doScan` picks up the rest.

**In the scan path** (`doScan`, `discoverInSubtree`):
```typescript
applyUserRuleToScan(result, root);  // shared helper
```
which is:
```typescript
if (cr.excludes.length > 0) applyExclusions(result.refs, result.elements, cr.excludes);
if (!cr.includeSelector) return;
const seen = new Set<Element>(result.refs);
for (const w of store.all) seen.add(w.element);
const extra = collectInclusions(seen, cr.includeSelector, root);
result.refs.push(...extra.refs);
result.elements.push(...extra.elements);
```

The `seen` set is only built when the rule has an include selector —
the more common exclude-only path doesn't pay the O(`store.all`) cost.

**In `reevaluateAttribute()` and `observeInvisibleCandidates()`:**
`isExcludedByRule(el, compiledRule.excludes)` is called after the
cheaper `isHintable(el)` short-circuit, so MO-discovered elements
that aren't hintable in the first place don't pay the exclude check.

**Timing:** Rules load asynchronously. The first `doScan()` at the
bottom of `content.ts` fires immediately. If rules haven't loaded yet,
that scan runs without them. The storage callback triggers a second
`doScan()` with rules applied. The gap is ~10ms — a brief flash of
extra badges on slow storage reads.

## Reveal Rules

Reveal rules inject page-level CSS that forces hover-hidden elements
visible. This is a genuine accessibility improvement — voice users
can't hover to reveal interactive elements.

### How sites hide elements

| Pattern | Scanner rejection | Reveal method | Layout risk |
|---------|-------------------|---------------|-------------|
| `opacity: 0` until parent `:hover` | `isVisible` rejects `opacity === '0'` | `opacity` | None |
| `visibility: hidden` until parent `:hover` | `isVisible` rejects | `visibility` | None |
| `display: none` until parent `:hover` | Zero dimensions | `display` (deferred) | Layout shifts |

### Implementation

A single `<style data-branchkit-reveal>` element in `<head>`:

```css
button.settings-button { opacity: 1 !important; }
section.tableReportDropdown button { opacity: 1 !important; }
```

One CSS rule per reveal entry. Injected once on page load, before the
first scan. On rule change, all `[data-branchkit-reveal]` stylesheets
are removed (covers our previous match and any orphans from a prior
content-script generation) and a fresh one is injected.

**Why CSS injection, not JS hover simulation:** `dispatchEvent` with
`MouseEvent` triggers JS handlers but does NOT activate the CSS
`:hover` pseudo-class. CSS injection is simpler, reliable, and
side-effect-free.

## UI

Two surfaces:

### Popup (`popup.html` / `src/popup.ts`)

The "fix THIS site" surface. Shows the rule matched against the active
tab's URL — or a "Create rule for `*.example.com`" affordance with a
suggested pattern when no rule matches. Compact entry list with inline
remove, an add-entry form (CSS-only matchers), and a codeword resolve
input that targets the active tab implicitly.

```
+----------------------------------------+
| BranchKit Browser                       |
| ● Connected                             |
| Hints: [Always visible ▾]               |
| Labels: [Letters ▾]                     |
|----------------------------------------|
| RULES FOR app.quickbase.com             |
|                                         |
|   *.quickbase.com        [✓ enabled]   |
|   – th.actionColumn[tabindex="0"]   ×   |
|   ◉ button.settings-button (opacity) ×  |
|                                         |
|   [exclude ▾]  [css selector_____] [Add]|
|   Pick: [hint codeword___] [Resolve]    |
|                                         |
| All domain rules…                       |
+----------------------------------------+
```

CSS-only matchers in the popup keep the UI compact. Text/class matchers
(exclude-only anyway) live in the options page.

### Options page (`options.html` / `src/options.ts`)

Cross-site rule list. Editable pattern field with live "matches current
tab" dot, all matcher types, per-rule tab picker for codeword resolve
(useful when you're configuring one site from another), and add/remove
for rules themselves.

Opens via `chrome.runtime.openOptionsPage()` from the popup link or
from chrome://extensions → BranchKit Browser → Details → Options.

### Visual indicators

Red minus (–) for excludes, green plus (+) for includes, blue dot (◉)
for reveals. Same conventions across popup and options. Pattern by
Rango.

## Codeword Resolution

The user types a visible hint codeword (e.g., "ape deck") instead of
hand-writing a CSS selector. Two-hop routing:

```
UI         → background          → content (specific frame)
RESOLVE_HINT_FROM_TAB              RESOLVE_HINT
  { tabId, codeword }                { codeword }
              │
              ▼
  getFrameForLabel(tabId, codeword)  // existing label-pool helper
              │
              ▼  chrome.tabs.sendMessage(tabId, ..., { frameId })
```

The content script's handler calls `store.byCodeword(codeword)` (a
shared `WrapperStore` method used by activate_hint and the snapshot
fallback too) and runs `generateSelector(wrapper.element)` from
`src/selector-generator.ts`. The selector-generator already implements
better heuristics than this design originally sketched: blacklist for
hash-like classes, `tag.className` for stable classes, `data-testid`
priority, ID quality checks, uniqueness verification, ancestor walks.
We did not write our own.

Response shape:

```typescript
type ResolveHintResponse =
  | { ok: true; selector: string; tagName: string; accessibleName: string }
  | { ok: false; reason: string };
```

The UI populates the matcher input with the selector and previews
`<tag> "name"` underneath. The user can edit before clicking Add.

## Example QuickBase Rules

Not shipped as defaults — kept here as reference for users who want to
recreate the rules that motivated this feature. Add via the popup or
options page.

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

**Deferred (`display:none`):**

| Element | Notes |
|---------|-------|
| Row-level action icons in `td.actionColumn` | Children are `display:none` until row hover. Forcing `display` risks layout shifts. |

## Files

New:
- `src/domain-rules.ts` + `src/domain-rules.test.ts` — types, pattern
  matching, `compileRule`, exclusion/inclusion/reveal helpers.
- `src/options-helpers.ts` + `src/options-helpers.test.ts` — pure
  helpers (`suggestPattern`, `isValidSelector`, `validatePattern`).
- `options.html` + `src/options.ts` — full options page.

Modified:
- `popup.html` + `src/popup.ts` — widened to 340px; added per-site
  rule editor.
- `src/content.ts` — `compiledRule` state, `applyUserRuleToScan`
  helper, storage init + onChanged listener, exclude check in
  `reevaluateAttribute` and `observeInvisibleCandidates`,
  `resolveHintLocally` handler.
- `src/background.ts` — `resolveHintFromTab` routing.
- `src/element-wrapper.ts` — shared `WrapperStore.byCodeword`.
- `src/types.ts` — `RESOLVE_HINT_FROM_TAB` / `RESOLVE_HINT` /
  `ResolveHintResponse`.
- `manifest.json` — `options_ui` entry.
- `package.json` + `scripts/dev.mjs` — esbuild target for options
  bundle.

## Implementation Status

All shipped 2026-05-22.

1. **`domain-rules.ts` + tests** — done; 41 tests pin pattern
   matching, compileRule bucketing, exclusion/inclusion/reveal.
2. **Wire into content.ts** — done; CompiledRule cached, scan path
   shared between `doScan` and `discoverInSubtree`, MO paths apply
   exclusion.
3. **Reveal injection lifecycle** — done; init via storage load,
   teardown + reinject on storage change.
4. **Options page** — done; cross-site rule list, pattern auto-fill,
   live match indicator, per-rule tab-picker resolve.
5. **Codeword resolution** — done via `RESOLVE_HINT_FROM_TAB` →
   `getFrameForLabel` → `RESOLVE_HINT` → `generateSelector`.
6. **Popup per-site editor** — done; active-tab implicit, CSS-only
   matchers, inline resolve.

Step 7 from the original plan (ship QuickBase seed defaults) was
dropped per Decision #3.
