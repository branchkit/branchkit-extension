/**
 * Tab navigation helpers (Layer 1 of notes/DESIGN_TAB_NAVIGATION.md).
 * Pure index math, separated from the chrome.tabs calls so it's unit-testable.
 */

/**
 * Index of the adjacent tab when cycling within a window, wrapping around.
 * `count` must be >= 1; `activeIdx` must be in [0, count).
 */
export function cycleTabIndex(
  activeIdx: number,
  count: number,
  direction: 'next' | 'previous',
): number {
  const delta = direction === 'next' ? 1 : -1;
  return (activeIdx + delta + count) % count;
}
