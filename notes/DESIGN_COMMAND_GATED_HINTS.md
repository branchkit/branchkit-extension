# Command-Gated Hints

## Problem

The current "show" trigger reveals every hintable element on the page. On dense pages this can mean 50-100 badges. Most of the time the user has intent: they want to click a link, fill a form field, or delete something. Showing all elements provides no help narrowing to that intent and adds cognitive load.

There is also a safety concern for destructive actions. "Show" then say a codeword offers no confirmation step — if the codeword resolves to the wrong element, the action fires. A user saying "delete" should see only delete-related elements, and the two-step model (say "delete", see the narrowed set, say the codeword) provides natural confirmation.

The browser plugin previously declared `show_hints_go` and `show_hints_set` action types in an older design pass. They were registered in `plugin.json` but never wired through the command system or forwarded to the extension. This design replaces that stub with a complete, extensible mechanism.

## Design

### Core Model

Command-gated hints introduce a set of filter-trigger words. When a user says one of these words, instead of showing all hints, the extension shows only the subset matching a filter. The user then confirms by saying the codeword of the revealed badge.

The two-step sequence is deliberate:
1. User says intent word ("delete") -- only delete-related elements appear
2. User says codeword -- the element activates

This is structurally identical to the existing two-word codeword model, but the first word is semantic intent rather than a random prefix.

### Filter Types

Two filter types cover the practical cases:

**Category filters** narrow by element type. The extension already classifies every element into `link | button | input | tab`. A category filter maps a trigger word to one or more of these values.

**Text filters** narrow by accessible name substring. An element passes if its `label` field (the accessible name computed at scan time) contains the filter string, case-insensitively.

Both filter types can be composed: "delete buttons only" would be category=button AND text="delete".

### Built-in Triggers

A default set covers common patterns without requiring any user configuration:

| Trigger word | Filter |
|---|---|
| `link` or `go` | category: link |
| `input` or `set` or `type` | category: input |
| `tab` | category: tab |
| `delete` or `remove` | text contains "delete" or "remove" |
| `save` or `submit` | text contains "save" or "submit" |
| `open` | text contains "open" |
| `close` | text contains "close" |

The existing "show" trigger is unchanged -- it shows all hints. These new triggers are additive.

### Extensibility

Users can define custom trigger words mapped to custom filters. A settings entry maps a word to a filter spec:

```json
{
  "trigger": "publish",
  "text_match": "publish"
}
```

Or a category-only filter:

```json
{
  "trigger": "buttons",
  "categories": ["button"]
}
```

Custom triggers participate in the same grammar system as built-in ones. The voice plugin sees them as additional commands that produce `show_hints_filtered` actions.

## Voice Command Flow

### New action type: `show_hints_filtered`

The browser plugin registers one command per trigger word. When matched, the actuator dispatches `browser.show_hints_filtered` with a `filter` param describing what to show.

Command structure (pushed alongside the existing "show"/"hide" commands):

```
pattern: ["delete"]
action: {type: "browser.show_hints_filtered", filter: "text:delete"}
requires_tags: [app.browser]
sets_tags: [plugin.browser.hints]
```

The extension receives a `show_hints_filtered` SSE event and calls `showHints` with the filter.

### Flow: "delete arch bake"

1. User says "delete"
2. Voice plugin matches the `delete` trigger command
3. Actuator dispatches `browser.show_hints_filtered` with `filter: "text:delete"`
4. Browser plugin pushes event to SSE
5. Extension receives `{action: "show_hints_filtered", params: {filter: "text:delete"}}`
6. Extension filters the store, shows only matching elements
7. Grammar is already live (the existing prefix/suffix collections cover all codewords)
8. User says "arch bake"
9. Voice plugin matches the prefix "arch" then suffix "bake" via the standard two-word resolution path
10. Extension activates the element

No grammar changes are needed beyond registering the trigger commands themselves -- the codeword grammar is already built from all visible elements, and the extension controls which elements are visible.

### Filter param encoding

The `filter` param on `show_hints_filtered` is a string with a simple prefix:

- `"category:link"` -- single category
- `"category:link,button"` -- multiple categories, comma-separated
- `"text:delete"` -- case-insensitive substring match against accessible name
- `"text:delete;category:button"` -- AND combination, semicolon-separated

The extension parses this string client-side. The browser plugin treats it as opaque -- it stores the raw filter string from config and passes it through.

## Action Types

### `browser.show_hints_filtered`

New action type to add to `plugin.json`:

```json
"show_hints_filtered": {
  "label": "Show Filtered Hints",
  "fields": [
    {
      "key": "filter",
      "label": "Filter spec",
      "placeholder": "category:link",
      "required": true
    }
  ]
}
```

### Existing action types

`browser.show_hints`, `browser.hide_hints`, `browser.noop`, `browser.activate` are unchanged.

## Extension-Side Filtering

### `showHints` already accepts a category filter

`content.ts` has `showHints(filter?: Category | Category[])` and `show_hints_category` in the dispatcher. The new feature generalizes this to also accept text filters.

### Changes to `showHints`

Extend the filter param type to accept a structured filter object:

```typescript
interface HintFilter {
  categories?: Category[];
  text?: string;        // case-insensitive substring match on label
}
```

The existing `Category` shorthand path stays for backwards compatibility. Text filtering walks `store.all` and checks `w.scanned.label.toLowerCase().includes(filter.text.toLowerCase())`.

### Parsing the filter param

A small `parseHintFilter(spec: string): HintFilter` utility converts the wire format to the filter object. Lives alongside the `show_hints_filtered` dispatcher registration in `content.ts`.

### Dispatcher registration

```typescript
dispatcher.register('show_hints_filtered', (params) => {
  const filter = parseHintFilter(params.filter || '');
  phraseSnapshot = takeSnapshot(store.all, performance.now());
  doScan();
  showHints(filter);
});
```

The phrase snapshot is captured at show-time so the codeword the user speaks later resolves against what they saw when the filter applied.

### BRANCHKIT_ACTION handler

The message listener's `action === 'show_hints'` branch already handles SSE-delivered show actions. Add a parallel branch for `show_hints_filtered`:

```typescript
} else if (action === 'show_hints_filtered') {
  phraseSnapshot = takeSnapshot(store.all, performance.now());
  doScan();
  showHints(parseHintFilter(params?.filter || ''));
}
```

## Browser Plugin Changes

### Grammar registration

`buildAllHintCommands` currently pushes "show" and "hide" as static commands. Extend it to also push filtered-show commands.

The trigger word list comes from a merged view of built-in triggers and user config. Each produces a `VoiceCommand`:

```go
triggerDesc := fmt.Sprintf("Show %s hints", trigger.Word)
commands = append(commands, VoiceCommand{
    Pattern:      []string{trigger.Word},
    Action:       map[string]interface{}{"type": pluginID + ".show_hints_filtered", "filter": trigger.FilterSpec},
    Description:  &triggerDesc,
    Category:     &cat,
    RequiresTags: triggerRequires,
    SetsTags:     []string{hintsTag},
})
```

### Static vocab

The trigger words themselves must be in the recognition vocabulary. They are added to the static vocab collection (`browser_hints_vocab`) alongside the 26 codeword prefixes so Vosk hears them during hint mode.

If a user adds custom trigger words, the static vocab push updates when the extension reconnects or the browser plugin restarts with new config.

### Config shape

In `BrowserConfig`, add a `FilteredTriggers` field:

```go
type FilteredTrigger struct {
    Word       string `json:"word"`
    FilterSpec string `json:"filter_spec"` // e.g. "text:delete" or "category:input"
}

type BrowserConfig struct {
    // ... existing fields ...
    CustomFilteredTriggers []FilteredTrigger `json:"custom_filtered_triggers,omitempty"`
    DisableBuiltinTriggers bool              `json:"disable_builtin_triggers,omitempty"`
}
```

Built-in triggers are defined in a package-level `builtinTriggers` slice. Merging with custom triggers is straightforward; custom entries with the same word as a built-in override the built-in (last-write-wins, custom entries checked first).

## Grammar Implications

### Trigger words must not collide with codeword prefixes

Each of the 26 codeword prefixes is a word from the user's chosen alphabet (default: NATO-style phonetics like "arch", "bake", "cape"). The trigger words must not overlap with these words or recognition is ambiguous.

The built-in trigger words ("link", "go", "input", "set", "type", "tab", "delete", "remove", "save", "submit", "open", "close") are chosen to avoid collision with standard phonetic alphabets. When a user configures a custom alphabet that does include one of these words, the browser plugin should log a warning at startup and that trigger should be disabled.

Collision detection runs in `initCodewords()` or in the function that merges triggers before pushing grammar: compare each trigger word against the 26 active codewords and log a warning (level: warn) for any match, skipping that trigger from the push.

### Trigger words in hint mode vs. outside hint mode

The existing trigger commands ("show", trigger words) all require either `app.browser` or no tags (to work from anywhere when a browser is focused). They produce `sets_tags: [plugin.browser.hints]`.

The pair-state codeword commands require `plugin.browser.hints`. The trigger words are consumed before hint mode activates -- they produce hint mode. There is no ambiguity: trigger words are only registered when hints are not yet visible, and codewords are only registered when hints are visible.

### "show" vs. filtered triggers

Both "show" and a filtered trigger set `plugin.browser.hints`. The extension distinguishes them by action type -- "show" sends `show_hints` and filtered triggers send `show_hints_filtered`. Both arrive via the same SSE channel.

## Edge Cases

### Filter produces zero matching elements

If the filter matches nothing visible in the current viewport, `showHints` exits early (existing behavior: `if (allTargets.length === 0) return`). The user hears no confirmation and no badges appear. This is acceptable -- the same thing happens today if "show" is said on a page with no hintable elements.

A future improvement could speak or display a brief "no matches" indicator, but that is out of scope here.

### Filter matches elements outside the viewport

`showHints` applies `viewportSort` which filters to viewport-visible elements. A text filter like "delete" might match elements that exist in the DOM but are scrolled off screen. Only the viewport-visible subset shows badges. The user may need to scroll and say the trigger again.

### Grammar push timing

The phraseSnapshot is captured at show-time. If the DOM mutates after the trigger fires but before the codeword is spoken, the snapshot's codewords may not cover the new elements. This is the same race condition that exists for "show" and is handled by the existing snapshot resolution fallback chain in `activate-resolution.ts`.

### Per-domain hint rules interaction

The per-domain hint rules feature (in parallel design) controls which elements are hintable at all. Command-gated filtering operates on top of whatever elements the domain rules have determined are hintable. The two are independent: domain rules control the full set; filter triggers control the visible subset of that full set. No ordering dependency.

### Custom trigger words containing spaces

The voice command pattern for a trigger is a single-element `[]string` containing one word. Multi-word trigger phrases ("submit form") are not supported in this design. The pattern array could be extended to `["submit", "form"]` but this conflicts with the two-word codeword model and adds ambiguity. Single-word triggers only.

### Always-mode vs. manual-mode

In always-mode (`hintVisibility === "always"`) hints are visible at all times. A filtered trigger in always-mode should replace the current full set with the filtered subset, not append to it. The existing `hideHints()` followed by `showHints(filter)` sequence handles this correctly -- `hideHints` clears all current badges, `showHints` renders only the filtered ones.

In manual-mode the hints are not visible between voice commands, so the trigger just activates hint mode with a filter as expected.

## Implementation Sketch

### Phase 1: Extension-side filtering (no voice)

1. Extend `HintFilter` type and `parseHintFilter` in `content.ts`.
2. Add `show_hints_filtered` dispatcher registration.
3. Add `show_hints_filtered` branch in the `BRANCHKIT_ACTION` message handler.
4. Update `showHints` to accept `HintFilter` in addition to the existing `Category` shorthand.
5. Test via the `branchkitShowHints` console hook with a manual filter object.

Phase 1 is fully self-contained in the extension. No browser plugin changes needed to test it.

### Phase 2: Browser plugin grammar registration

1. Add `show_hints_filtered` to `plugin.json` action types.
2. Add `FilteredTrigger` and `CustomFilteredTriggers` to `BrowserConfig`.
3. Define `builtinTriggers` slice in `collections.go`.
4. Extend `buildAllHintCommands` to emit filtered-show commands for each trigger.
5. Add trigger words to static vocab push in `pushStaticVocab`.
6. Add collision detection in `initCodewords`.
7. Run `just gen-plugins` to regenerate `actions_gen.go`.

### Phase 3: Settings UI

1. Add a "Filtered triggers" section to the browser plugin settings tab.
2. Allow users to add custom trigger word + filter spec pairs.
3. Add a toggle to disable built-in triggers for users who prefer a minimal command set.
4. Persist via `plugin.browser.config` collection.

Phase 3 is independent of Phase 1 and 2. Custom triggers require the Phase 2 grammar wiring to take effect.

## Future: convergence with per-domain hint rules

There is a potential convergence point between command-gated hints and
per-domain hint rules (see `DESIGN_PER_DOMAIN_HINT_RULES.md`). The
underlying idea: both features are about controlling which elements appear
and when, but from different angles — domain rules are static visibility
rules, command-gated hints are dynamic per-command filters.

A unifying primitive would be **named element references per domain**. A user
identifies an element on a frequently-used site, gives it a name ("save
button"), and that name becomes part of the site's vocabulary. Domain rules
could hide a named element by default, while a command-gated trigger could
reveal it: say "save" and the element named "save button" appears. The voice
system resolves against user-curated names rather than heuristic text
matching on accessible names.

This would turn per-domain rules from exclusion lists into semantic site maps
— a user-curated layer that bridges DOM structure and voice commands. A named
reference is structurally a domain rule entry with an additional `name` field
and a `gate` field linking it to a trigger word.

This is not a v1 concern for either feature. Build both independently first;
the shape of the bridge will be clear once both exist. The current designs
don't close the door — the data models can be extended without breaking
existing rules or trigger configs.
