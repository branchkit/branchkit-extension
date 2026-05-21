# Per-Domain Hint Rules

User-defined scan rules that exclude or include elements on specific domains, applied at scan time so excluded elements never receive badges.

## Problem

The current hint system applies the same scanning logic everywhere. `HINTABLE_SELECTOR` + `EXCLUDE_SELECTOR` + `isVisible` + `isRedundant` are universal. The adapter system in `src/adapters/` allows site-specific overrides, but adapters are hardcoded and ship in the extension bundle — users can't configure their own.

Common user needs:

- A site renders 50+ toolbar icon buttons that clutter the badge layer; the user wants to exclude them by CSS class.
- A site renders a custom drag handle with `tabindex="0"` that is hintable but irrelevant to voice navigation.
- A site has elements not in `HINTABLE_SELECTOR` (e.g., custom `[data-clickable]` elements) that the user wants to reach by voice.
- A Quickbase app variant uses slightly different CSS selectors than the built-in adapter covers.

## Design

### Data model

A user defines one or more **domain rules**. Each rule targets a domain or domain pattern and carries a list of **rule entries** — individual exclusions or inclusions.

```
DomainRules (stored object):
  rules: DomainRule[]

DomainRule:
  id: string           -- UUID, stable reference
  pattern: string      -- "quickbase.com" | "*.quickbase.com" | "example.com/app/*"
  enabled: boolean
  entries: RuleEntry[]

RuleEntry:
  id: string           -- UUID
  kind: "exclude" | "include"
  matcher: Matcher

Matcher (tagged union):
  | { type: "css";  selector: string }
  | { type: "text"; value: string; caseSensitive: boolean }
  | { type: "class"; name: string }
```

`kind: "exclude"` — any hintable element matched by this entry is dropped from the scan result.

`kind: "include"` — elements matching this entry are added even if they didn't match `HINTABLE_SELECTOR`. Semantically identical to `SiteAdapter.include`, but user-defined.

### Pattern matching

Patterns are matched against `window.location.href` at scan time. Matching is intentionally simple — no full glob library, just the two rules users need:

1. A leading `*.` means any subdomain: `*.quickbase.com` matches `app.quickbase.com` and `realm.quickbase.com` but not `quickbase.com` itself.
2. A trailing `/*` or any internal `*` is treated as "starts with this prefix": `example.com/app/*` matches any URL whose path starts with `/app/`.
3. Anything else is an exact host match (path is ignored unless explicitly included in the pattern).

The match function is ~20 lines and lives in a new `src/domain-rules.ts` module, co-located with evaluation and storage helpers.

### Storage schema

Stored in `chrome.storage.sync` so rules sync across the user's browsers.

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
            "matcher": { "type": "css", "selector": ".qb-toolbar-btn[aria-label='More']" }
          },
          {
            "id": "6ba7b811-...",
            "kind": "include",
            "matcher": { "type": "css", "selector": "[data-qb-draggable]" }
          }
        ]
      }
    ]
  }
}
```

The outer key is `domainRules`. Absence of the key means no user rules; the scan behaves as today.

`chrome.storage.sync` limits: 8KB per item, 100KB total. A domain rule is small (a few hundred bytes of JSON), so limits are not a concern in practice. If a user somehow exceeds them, `chrome.runtime.lastError` will surface at write time; the UI should surface this as a save error.

### Rule evaluation

Rule evaluation runs inside `scanElements` and `scanWithAdapter`. The new module exports two functions:

```ts
// src/domain-rules.ts

export function loadRulesForURL(url: string, allRules: DomainRule[]): DomainRule | null

export function applyExclusions(
  refs: Element[],
  elements: ScannedElement[],
  rule: DomainRule,
): { refs: Element[]; elements: ScannedElement[] }

export function applyInclusions(
  seen: Set<Element>,
  rule: DomainRule,
): { refs: Element[]; elements: ScannedElement[] }
```

`loadRulesForURL` finds the first enabled rule whose pattern matches the URL. If multiple rules match the same domain, only the first is applied. (Multiple rules per domain is a v2 consideration.)

`applyExclusions` iterates the filtered refs backward (like the adapter's existing exclusion loop) and removes entries where any exclude entry matches. CSS matchers call `el.matches(selector)`. Text matchers walk `el.textContent?.trim()`. Class matchers call `el.classList.contains(name)`.

`applyInclusions` queries the DOM for include entries with CSS selectors, skipping already-seen elements. Text and class inclusion matchers search via `document.querySelectorAll('*')` filtered by the matcher — this is slower but only runs when an include rule is present.

**Integration point in `content.ts` — `doScan()`:**

```ts
function doScan(): void {
  const adapter = getActiveAdapter(window.location.href);
  const result = adapter ? scanWithAdapter(adapter) : scanElements();

  // Apply user-defined domain rules on top of adapter/generic results.
  const userRule = getActiveUserRule(window.location.href);  // cached from storage
  if (userRule) {
    applyUserRule(result, userRule);
  }

  // ... rest unchanged
}
```

`getActiveUserRule` reads from a module-level cache that is populated on load and updated via `chrome.storage.onChanged`. No async required in the hot scan path.

**Integration in MutationObserver path:**

`discoverInSubtree` calls `scanElements(root)`, not `doScan`. The user rule must also be consulted here. The simplest fix: after `attachWrapper` in `discoverInSubtree`, check the user exclude rule and skip if matched. A thin wrapper `scanElementsWithRule(root, rule)` handles this without duplicating the exclusion logic.

`isHintable` is used by `reevaluateAttribute` and the ResizeObserver. User exclude rules need to be checked there too, or newly-revealed elements that match an exclude rule will pick up wrappers mid-session. Extend `isHintable` to accept an optional rule parameter; callers in content.ts pass the cached rule.

### Settings UI approach

There are two natural homes for this UI: the extension popup (`popup.html`) and the BranchKit app settings at `localhost:21551`. The popup is the right first choice because:

- It requires no network connectivity to BranchKit (the rules are pure browser-side state).
- The popup already has storage access patterns for `badgeDisplayMode` and `hintVisibility`.
- Users expect per-site customization to live in the extension itself.

The popup gains a "Domain Rules" section below the existing controls. For v1, a minimal form:

- A list of existing rules (pattern + enabled toggle + delete button).
- "Add rule" opens an inline form: pattern field, then a list of entries (kind selector + matcher type + value), with an "Add entry" button.
- Save writes to `chrome.storage.sync`. Validation: CSS selectors are validated via `document.querySelector` in a try/catch; invalid selectors are flagged before save.

The popup is currently ~50 lines of vanilla JS in `popup.ts`. The domain rules section will need a small amount of DOM manipulation. Keep it vanilla — no framework. The popup is too small to justify a build step dependency.

For power users who prefer it: the BranchKit app settings tab for the browser plugin can expose a JSON editor for the full `domainRules` object. This is optional and comes later.

### Element selection via hint codeword

Typing CSS selectors is hostile to non-developer users. The primary way to
add entries should be through the hint system itself: the user types a hint
codeword they can see on the page, and the extension resolves it to a stable
matcher.

**Flow (exclude):**

1. User has the page open with hints visible. They see a badge they want to
   exclude — say "ape deck" on the Delete button.
2. In the popup's "Add entry" form, the user types `ape deck` into a
   "Hint codeword" field.
3. The popup sends a `RESOLVE_HINT` message to the content script with the
   codeword.
4. The content script resolves codeword -> wrapper -> element. It extracts
   a stable matcher from the element and returns it along with a human-readable
   preview (e.g., `<a class="deleteBtn">Delete</a>`).
5. The popup displays the preview and the generated matcher for confirmation:
   "Exclude: Delete button (.deleteBtn)". The user can accept, edit the
   matcher, or switch matcher type (CSS / text / class).
6. On confirm, the entry is added to the rule. The codeword is never persisted
   — only the stable matcher is saved.

**Flow (include):** Same as exclude, but the user types the codeword of a
nearby element and then manually adjusts the generated selector to target
the unhinted element. Alternatively, the user can type a CSS selector or
text match directly — includes are a power-user feature and less common
than excludes.

**Why this works despite hint instability:** Codewords change between page
loads (they're assigned by DOM order and the pool rotates). But the codeword
is only used as a pointing device at rule-creation time. The extension
resolves it to the live element, derives a durable matcher, and discards the
codeword. It's equivalent to clicking — just typed instead.

**Constraint:** The page must be open with hints showing when the user creates
the rule. The popup can detect this and show a message ("Show hints on the
page first") if no hints are active. This is natural — the user notices
something they want to exclude precisely when hints are visible.

**Fallback: manual entry.** For power users or cases where the hint approach
doesn't fit, the form also accepts direct CSS selectors, text matches, or
class names typed by hand. The hint codeword field is the primary input, but
the matcher type dropdown lets the user switch to manual at any time.

### Selector generation heuristics

When resolving a hint to a stable matcher, the extension inspects the
underlying element and generates the best available selector (in priority
order):

1. `tag.className` — if the element has 1-3 short class names that aren't
   hash-based (no CSS module hashes or Tailwind utility classes like `p-4`).
   Example: `a.deleteBtn`.
2. `[attribute="value"]` — for elements with semantic attributes like
   `data-action`, `aria-label`, `role`.
   Example: `a[aria-label="Delete"]`.
3. `#id` — if the element has an `id` that doesn't look generated (no UUIDs,
   no numeric suffixes beyond single digits). Ranked below class because
   many apps generate unstable ids.
4. Text content match — last resort. Uses `{ type: "text", value: "Delete",
   caseSensitive: false }` rather than a CSS selector. Appropriate when the
   element has no stable attributes but has distinctive text.

The heuristics don't need to be perfect — the user sees and confirms the
result. A rough matcher that the user tweaks is faster than writing one
from scratch. The preview shows the element tag, text, and key attributes
so the user can judge whether the matcher is specific enough.

### Migration from hardcoded adapters

The QuickBase adapter currently has no `exclude` function (it was recently removed). Its `categories` scans (edit/view record icons, sidebar table links) are additive — they cannot be expressed as user-defined CSS `include` entries because they carry custom labels ("Edit row 3") and custom categories (`'edit'`, `'tables'`). The adapter system stays for these structural scans.

The migration path for users currently relying on hardcoded exclusions in adapters (if any were shipped before removal):

1. On extension update, no automatic migration is needed — the old exclusions are gone and the new user rule system is the replacement.
2. The QuickBase adapter's `include`/`exclude` fields are still in `SiteAdapter` for future hardcoded use. User rules layer on top of adapter results, not below them. Order of operations at scan time:

   ```
   1. Generic scan (HINTABLE_SELECTOR + isVisible + isRedundant)
   2. Adapter exclusions (adapter.exclude)
   3. Adapter inclusions (adapter.include)
   4. Adapter category scans (adapter.categories)
   5. User exclude rules
   6. User include rules
   ```

   User rules run last so they can override adapter decisions.

### Edge cases

**Invalid CSS selectors.** Validate at entry-save time. At scan time, wrap `el.matches(selector)` in a try/catch and log a console.warn with the selector text; treat the entry as a no-op. Don't throw — a bad selector should degrade gracefully, not break scanning.

**Very broad include selectors.** `"*"` as a CSS include selector would add every element on the page. No limit is enforced, but the label pool caps badge count at 676 (`MAX_BADGE_COUNT`) naturally. Document this in the UI rather than adding a hard reject.

**Rule pattern specificity conflicts.** If a user has rules for both `example.com` and `*.example.com`, the first matching rule wins (array order). The UI should reflect this (display rules in order, allow reordering in v2).

**Storage sync conflicts.** `chrome.storage.sync` resolves write conflicts last-write-wins per key. Since `domainRules` is a single key, concurrent edits from two browsers will collide. This is acceptable for v1; the user loses edits in the same way they would for any sync conflict. If this becomes a complaint, split to one key per rule (`domainRules:${id}`).

**Adapter category scans and user include rules.** The categories mechanism assigns custom labels and categories; user include rules use `classifyCategory` from `scanner.ts` and generate labels from `accessibleName`. They produce structurally identical `ScannedElement` objects but with `adapter: null`. Voice matching is unaffected — elements reach the grammar push regardless of adapter field value.

**Content script not yet loaded vs. rule not yet cached.** Rules are loaded asynchronously from `chrome.storage.sync` on content script init. The first `doScan()` (at the bottom of `content.ts`) fires immediately; if the async load hasn't completed yet, no user rules are applied to that first scan. The storage callback calls `doScan()` again once rules are loaded, same pattern as `setAlphabet`. This means the first-render scan on slow connections may show extra badges briefly, but they'll be corrected within one storage round-trip (~10ms typical).

**MV3 service worker + storage.onChanged.** User rules changes from the popup must also propagate to already-open tabs. `chrome.storage.onChanged` fires in every content script context when the popup saves, so the cache update and rescan happen automatically.

## Files to create or modify

- `src/domain-rules.ts` — new. Pattern matching, rule evaluation, storage helpers, TypeScript types.
## Future: named element references

There is a potential convergence point between per-domain hint rules and
command-gated hints (see `DESIGN_COMMAND_GATED_HINTS.md`). Both features
operate on the same underlying question: which elements should be visible,
and when?

The unifying primitive would be **named element references per domain**. A
user identifies an element (via hint codeword), gives it a name ("save
button"), and attaches behavior to that name:

- `visibility: hidden` — the element never gets a badge (domain rule)
- `gate: "delete"` — the badge only appears when the user says "delete"
  (command-gated hint)
- `label: "Save"` — a custom voice-friendly label overriding the accessible
  name

Over time the user builds a per-domain semantic map: named handles for the
elements they interact with most. The voice system can reference these names
directly instead of guessing from accessible names or CSS structure. This
turns per-domain rules from a negative-space feature (hiding things) into a
positive-space one (curating a site vocabulary).

A name like "save" would need multiple matchers even within a single domain.
A site like QuickBase renders different save elements depending on the page
context:

```
"save button" on *.quickbase.com:
  -> a.saveBtn                    (form edit page)
  -> button.save-record           (inline editor)
  -> [data-action="save"]         (pipeline builder)
```

At scan time the extension tries all matchers for the name on the current
domain; whichever one hits a live element wins. A name is a bag of matchers,
not a single selector.

Across domains, the same name maps to entirely different matcher sets:

```
"save button":
  *.quickbase.com  -> [a.saveBtn, button.save-record, ...]
  github.com       -> [button[type="submit"]]
  docs.google.com  -> [[aria-label="Save"]]
```

The voice system only knows the name; the extension resolves it to the
correct matcher for the current domain and page. The user says "save"
everywhere and the right element lights up regardless of how each site
implements it.

This is not a v1 concern. The current design (rules with matchers) doesn't
close the door on it — a named reference is structurally a rule entry with
an additional `name` field and a `gate` field. The data model can be extended
without breaking existing rules. Build domain rules and command-gated hints
independently first; the shape of the bridge will be obvious once both exist.

## Files to create or modify

- `src/scanner.ts` — extend `isHintable` to accept an optional `DomainRule | null` parameter.
- `src/adapters/index.ts` — apply user rule after adapter scan in `scanWithAdapter`.
- `src/content.ts` — load rules from storage on init, cache in module scope, pass to `doScan` / `discoverInSubtree` / `reevaluateAttribute`.
- `popup.ts` + `popup.html` — add Domain Rules section.
