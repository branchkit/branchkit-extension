/**
 * Client-side mirror of the actuator's command-phrase override validation
 * (`validate_override_phrase` in actuator/src/commands.rs) — for instant editor
 * feedback. The server is authoritative; this catches the common mistakes
 * before a round trip.
 *
 * Phrases are in the extension's `{name}` capture notation (the browser plugin
 * translates to the actuator's `<name>` form on the way through). See
 * notes/DESIGN_COMMAND_PHRASE_OVERRIDES.md.
 */

/** True iff `word` is a `{…}` capture token. */
function isCapture(word: string): boolean {
  return word.length >= 2 && word.startsWith('{') && word.endsWith('}');
}

/** The inner name of a capture token (`{number}` → `number`). */
function innerName(token: string): string {
  return token.slice(1, -1);
}

/**
 * An "open" capture is one the recognizer can't statically enumerate, so it
 * must be the last word: free text (`{text}`), a repeat (`{…+}`), or the hint
 * codeword (`{hint}` expands to a dependent capture). Named list captures
 * (`{number}`, `{tab}`) are closed and may appear anywhere.
 */
function isOpen(token: string): boolean {
  const inner = innerName(token);
  return inner === 'text' || inner === 'hint' || inner.endsWith('+');
}

/**
 * The `{…}` capture tokens of a phrase, sorted — its comparable signature. Two
 * phrases with the same signature bind the same params. Literal words ignored.
 */
export function captureTokens(phrase: string): string[] {
  return phrase
    .trim()
    .split(/\s+/)
    .filter((w) => isCapture(w))
    .sort();
}

/**
 * A stable key for an override: (action, defaultPattern). NUL delimiter so an
 * action or pattern containing spaces can't collide.
 */
export function overrideKey(action: string, defaultPattern: string): string {
  return action + String.fromCharCode(0) + defaultPattern;
}

/**
 * Validate a replacement phrase against the default it replaces. Returns a
 * user-facing error message, or `null` when the phrase is well-formed.
 */
export function validateOverridePhrase(
  defaultPattern: string,
  newPattern: string,
): string | null {
  const trimmed = newPattern.trim();
  if (trimmed === '') return 'Enter a phrase.';

  const tokens = trimmed.split(/\s+/);

  for (const t of tokens) {
    if (isCapture(t)) continue;
    if (!/^[a-z]+$/.test(t)) {
      return `“${t}” must be lowercase letters only — other characters can’t be heard.`;
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (isCapture(tokens[i]) && isOpen(tokens[i]) && i !== tokens.length - 1) {
      return `${tokens[i]} must be the last word — anything after it is ignored.`;
    }
  }

  if (tokens.length > 0 && isCapture(tokens[0]) && innerName(tokens[0]) === 'text') {
    return 'A phrase can’t begin with a free-text slot — start with a fixed word.';
  }

  const want = captureTokens(defaultPattern);
  const got = captureTokens(trimmed);
  if (want.length !== got.length || want.some((t, i) => t !== got[i])) {
    return want.length === 0
      ? 'This phrase has no placeholders — remove them.'
      : `Keep the same placeholders as the default (${want.join(' ')}) — rename the words around them, not the placeholders.`;
  }

  return null;
}
