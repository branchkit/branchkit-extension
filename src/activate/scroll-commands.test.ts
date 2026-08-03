/**
 * BranchKit Browser — scroll command binding tests.
 *
 * Fourteen commands that had no test at all while they were inline in
 * content.ts. What is pinned is the BINDING, not the scrolling: which
 * scroller entry point each command reaches and with what arguments.
 * scroller.ts's own behaviour is covered in scroller.test.ts.
 *
 * The one rule worth its own assertions is the cycle-target delegate: ten of
 * the fourteen scroll the user's cycled target when there is one and the page
 * when there is not, and that rule was written out ten times before this
 * module collapsed it into one.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type ScrollCommands = typeof import('./scroll-commands');

type Handler = (params: Record<string, string>) => void;
const registered = new Map<string, Handler>();
const dispatcher = { register: (a: string, fn: Handler) => { registered.set(a, fn); } };

const calls: string[] = [];
const scroll = vi.fn((...a: unknown[]) => { calls.push(`scroll(${a.join(',')})`); });
const scrollElement = vi.fn((el: unknown, ...a: unknown[]) =>
  { calls.push(`scrollElement(${(el as { id: string }).id},${a.join(',')})`); });
const scrollToPercent = vi.fn((...a: unknown[]) => { calls.push(`scrollToPercent(${a.join(',')})`); });
const scrollRegion = vi.fn((...a: unknown[]) => { calls.push(`scrollRegion(${a.join(',')})`); });
const snapToElement = vi.fn((el: unknown, pos: unknown) =>
  { calls.push(`snapToElement(${(el as Element).id},${pos})`); });
const cycleScrollTarget = vi.fn(() => { calls.push('cycleScrollTarget()'); return null; });

let cycleTarget: unknown = null;

async function load(): Promise<ScrollCommands> {
  vi.resetModules();
  vi.doMock('../core/singletons', () => ({ dispatcher }));
  vi.doMock('./scroller', () => ({
    scroll, scrollElement, scrollToPercent, scrollRegion, snapToElement,
    cycleScrollTarget, getCycleTarget: () => cycleTarget,
  }));
  const m = await import('./scroll-commands');
  m.registerScrollCommands();
  return m;
}

const run = (action: string, params: Record<string, string> = {}) => {
  const h = registered.get(action);
  if (!h) throw new Error(`${action} was never registered`);
  h(params);
};

beforeEach(() => {
  registered.clear();
  calls.length = 0;
  cycleTarget = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock('../core/singletons');
  vi.doUnmock('./scroller');
});

describe('registration', () => {
  it('registers every scroll command content.ts used to hold', async () => {
    await load();
    expect([...registered.keys()].sort()).toEqual([
      'cycle_scroll_target', 'scroll', 'scroll_bottom', 'scroll_down',
      'scroll_full_down', 'scroll_full_up', 'scroll_half_down', 'scroll_half_up',
      'scroll_left', 'scroll_right', 'scroll_target_pick', 'scroll_to_element',
      'scroll_to_percent', 'scroll_top', 'scroll_up',
    ]);
  });

  it('registers nothing at import time — the entry point decides when', async () => {
    vi.resetModules();
    vi.doMock('../core/singletons', () => ({ dispatcher }));
    vi.doMock('./scroller', () => ({
      scroll, scrollElement, scrollToPercent, scrollRegion, snapToElement,
      cycleScrollTarget, getCycleTarget: () => cycleTarget,
    }));
    await import('./scroll-commands');
    expect(registered.size).toBe(0);
  });
});

describe('the cycle-target rule', () => {
  it('scrolls the PAGE when the user has not cycled a target', async () => {
    await load();
    run('scroll_down');
    expect(calls).toEqual(['scroll(down,step,1)']);
    expect(scrollElement).not.toHaveBeenCalled();
  });

  it('scrolls the CYCLED TARGET when there is one, and never the page as well', async () => {
    await load();
    cycleTarget = { id: 'sidebar' };
    run('scroll_down');
    expect(calls).toEqual(['scrollElement(sidebar,down,step,1)']);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('applies the rule to all ten direction/amount bindings', async () => {
    await load();
    cycleTarget = { id: 'pane' };
    for (const a of ['scroll_down', 'scroll_up', 'scroll_half_down', 'scroll_half_up',
      'scroll_full_down', 'scroll_full_up', 'scroll_top', 'scroll_bottom',
      'scroll_left', 'scroll_right']) run(a);
    expect(calls).toEqual([
      'scrollElement(pane,down,step,1)', 'scrollElement(pane,up,step,1)',
      'scrollElement(pane,down,half,1)', 'scrollElement(pane,up,half,1)',
      'scrollElement(pane,down,full,1)', 'scrollElement(pane,up,full,1)',
      'scrollElement(pane,up,top,1)', 'scrollElement(pane,down,bottom,1)',
      'scrollElement(pane,left,step,1)', 'scrollElement(pane,right,step,1)',
    ]);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('maps every binding to its own direction and amount', async () => {
    await load();
    for (const a of ['scroll_down', 'scroll_up', 'scroll_half_down', 'scroll_half_up',
      'scroll_full_down', 'scroll_full_up', 'scroll_top', 'scroll_bottom',
      'scroll_left', 'scroll_right']) run(a);
    expect(calls).toEqual([
      'scroll(down,step,1)', 'scroll(up,step,1)',
      'scroll(down,half,1)', 'scroll(up,half,1)',
      'scroll(down,full,1)', 'scroll(up,full,1)',
      'scroll(up,top,1)', 'scroll(down,bottom,1)',
      'scroll(left,step,1)', 'scroll(right,step,1)',
    ]);
  });

  it('re-reads the cycle target per command, so cycling mid-session takes effect', async () => {
    await load();
    run('scroll_down');
    cycleTarget = { id: 'later' };
    run('scroll_down');
    expect(calls).toEqual(['scroll(down,step,1)', 'scrollElement(later,down,step,1)']);
  });
});

describe('count', () => {
  it('passes a repeat count through on the step bindings', async () => {
    await load();
    run('scroll_down', { count: '5' });
    run('scroll_up', { count: '3' });
    expect(calls).toEqual(['scroll(down,step,5)', 'scroll(up,step,3)']);
  });

  it('falls back to 1 for missing, empty, zero and non-numeric counts', async () => {
    await load();
    for (const count of ['', '0', 'lots', 'NaN']) {
      calls.length = 0;
      run('scroll_down', { count });
      expect(calls, `count=${JSON.stringify(count)}`).toEqual(['scroll(down,step,1)']);
    }
    calls.length = 0;
    run('scroll_down');
    expect(calls).toEqual(['scroll(down,step,1)']);
  });

  it('the amount-only bindings do not take a count from the params', async () => {
    await load();
    run('scroll_half_down', { count: '9' });
    expect(calls).toEqual(['scroll(down,half,1)']);
  });
});

describe('the generic scroll command', () => {
  it('defaults to one step down', async () => {
    await load();
    run('scroll');
    expect(calls).toEqual(['scroll(down,step,1)']);
  });

  it('takes direction, amount and count from the params', async () => {
    await load();
    run('scroll', { direction: 'up', amount: 'full', count: '2' });
    expect(calls).toEqual(['scroll(up,full,2)']);
  });

  it('routes to a named region when one is given', async () => {
    await load();
    run('scroll', { region: 'leftSidebar', direction: 'down', amount: 'half' });
    expect(calls).toEqual(['scrollRegion(leftSidebar,down,half,1)']);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('does NOT consult the cycle target, unlike the ten above', async () => {
    await load();
    cycleTarget = { id: 'pane' };
    run('scroll', { direction: 'down' });
    // Preserved asymmetry, pinned so a later "tidy-up" has to mean it: this
    // one scrolls the page even with a target cycled. See the module comment.
    expect(calls).toEqual(['scroll(down,step,1)']);
    expect(scrollElement).not.toHaveBeenCalled();
  });
});

describe('the positional commands', () => {
  it('scroll_to_percent defaults to halfway and parses the param', async () => {
    await load();
    run('scroll_to_percent');
    run('scroll_to_percent', { percent: '80' });
    expect(calls).toEqual(['scrollToPercent(50)', 'scrollToPercent(80)']);
  });

  it('scroll_to_element snaps to a matched selector, top by default', async () => {
    await load();
    document.body.innerHTML = '<div id="target"></div>';
    run('scroll_to_element', { selector: '#target' });
    run('scroll_to_element', { selector: '#target', position: 'center' });
    expect(calls).toEqual(['snapToElement(target,top)', 'snapToElement(target,center)']);
  });

  it('scroll_to_element does nothing without a selector, or when nothing matches', async () => {
    await load();
    document.body.innerHTML = '<div id="target"></div>';
    run('scroll_to_element');
    run('scroll_to_element', { selector: '' });
    run('scroll_to_element', { selector: '#nope' });
    expect(snapToElement).not.toHaveBeenCalled();
  });

  it('cycle_scroll_target advances the target', async () => {
    await load();
    run('cycle_scroll_target');
    expect(calls).toEqual(['cycleScrollTarget()']);
  });
});
