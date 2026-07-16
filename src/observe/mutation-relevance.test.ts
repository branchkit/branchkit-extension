import { describe, it, expect, afterEach } from 'vitest';
import { mutationTouchesTracked } from './mutation-relevance';

const mounted: Element[] = [];
function mount(html: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  mounted.push(wrapper);
  return wrapper;
}
afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
});

function attrRecord(target: Element, attributeName = 'class', oldValue: string | null = null): MutationRecord {
  return {
    type: 'attributes', target, attributeName, oldValue, addedNodes: [], removedNodes: [],
  } as unknown as MutationRecord;
}
function childRecord(target: Element, added: Element[] = [], removed: Element[] = []): MutationRecord {
  return {
    type: 'childList', target, addedNodes: added, removedNodes: removed,
  } as unknown as MutationRecord;
}

describe('mutationTouchesTracked', () => {
  it('irrelevant: attribute flip on an element unrelated to any tracked element', () => {
    const root = mount('<div id="tick"></div><a id="tracked" href="#">x</a>');
    const tick = root.querySelector('#tick')!;
    const tracked = root.querySelector('#tracked')!;
    expect(mutationTouchesTracked([attrRecord(tick)], [[tracked]])).toBe(false);
  });

  it('relevant: attribute flip on an ancestor of a tracked element', () => {
    const root = mount('<div id="panel"><a id="tracked" href="#">x</a></div>');
    const panel = root.querySelector('#panel')!;
    const tracked = root.querySelector('#tracked')!;
    expect(mutationTouchesTracked([attrRecord(panel)], [[tracked]])).toBe(true);
  });

  it('irrelevant: attribute flip on a node strictly inside a tracked element', () => {
    // A descendant's style/class cannot change the tracked element's computed
    // visibility; size-collapse side effects ride the ResizeObserver paths.
    const root = mount('<a id="tracked" href="#"><span id="label">x</span></a>');
    const label = root.querySelector('#label')!;
    const tracked = root.querySelector('#tracked')!;
    expect(mutationTouchesTracked([attrRecord(label)], [[tracked]])).toBe(false);
  });

  it('relevant: attribute flip on the tracked element itself', () => {
    const root = mount('<a id="tracked" href="#">x</a>');
    const tracked = root.querySelector('#tracked')!;
    expect(mutationTouchesTracked([attrRecord(tracked, 'style')], [[tracked]])).toBe(true);
  });

  it('irrelevant: ancestor style tick that cannot affect visibility (the Gmail T-aT4-Mp case)', () => {
    const root = mount('<div id="panel" style="width: 30%"><a id="tracked" href="#">x</a></div>');
    const panel = root.querySelector('#panel')!;
    const tracked = root.querySelector('#tracked')!;
    expect(mutationTouchesTracked([attrRecord(panel, 'style', 'width: 20%')], [[tracked]])).toBe(false);
  });

  it('relevant: ancestor style write that touches display', () => {
    const root = mount('<div id="panel" style="display: none"><a id="tracked" href="#">x</a></div>');
    const panel = root.querySelector('#panel')!;
    const tracked = root.querySelector('#tracked')!;
    expect(mutationTouchesTracked([attrRecord(panel, 'style', '')], [[tracked]])).toBe(true);
  });

  it('relevant: ancestor reveal by REMOVING display:none (old value carries the keyword)', () => {
    const root = mount('<div id="panel"><a id="tracked" href="#">x</a></div>');
    const panel = root.querySelector('#panel')!;
    const tracked = root.querySelector('#tracked')!;
    expect(mutationTouchesTracked([attrRecord(panel, 'style', 'display: none')], [[tracked]])).toBe(true);
  });

  it('relevant: removed subtree contained a tracked element', () => {
    const root = mount('<div id="row"><a id="tracked" href="#">x</a></div>');
    const row = root.querySelector('#row') as HTMLElement;
    const tracked = root.querySelector('#tracked')!;
    row.remove();
    expect(mutationTouchesTracked([childRecord(root, [], [row])], [[tracked]])).toBe(true);
  });

  it('irrelevant: untracked sibling removed under a shared parent', () => {
    const root = mount('<div><div id="spinner"></div><a id="tracked" href="#">x</a></div>');
    const spinner = root.querySelector('#spinner') as HTMLElement;
    const tracked = root.querySelector('#tracked')!;
    spinner.remove();
    // The PARENT contains the tracked element, but the mutated node (the
    // removed spinner) does not — reflow territory, not settle territory.
    expect(mutationTouchesTracked([childRecord(root.firstElementChild ?? root, [], [spinner])], [[tracked]])).toBe(false);
  });

  it('own badge hosts never count as page mutations', () => {
    const root = mount('<div data-branchkit-hint="1"><span>b</span></div><a id="tracked" href="#">x</a>');
    const host = root.querySelector('[data-branchkit-hint]')!;
    const tracked = root.querySelector('#tracked')!;
    // The host CONTAINS nothing tracked and is excluded outright even though
    // a containment test against the page would relate it to ancestors.
    expect(mutationTouchesTracked([attrRecord(host)], [[tracked]])).toBe(false);
  });

  it('reaches tracked elements inside shadow roots via composed containment', () => {
    const root = mount('<div id="panel"><div id="host"></div></div>');
    const panel = root.querySelector('#panel')!;
    const host = root.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const tracked = document.createElement('a');
    shadow.appendChild(tracked);
    expect(mutationTouchesTracked([attrRecord(panel)], [[tracked]])).toBe(true);
  });

  it('fails open past the distinct-node cap', () => {
    const root = mount('<div></div>');
    const records: MutationRecord[] = [];
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      root.appendChild(el);
      records.push(attrRecord(el));
    }
    // No tracked sets at all — only the cap can make this true.
    expect(mutationTouchesTracked(records, [[]])).toBe(true);
  });

  it('empty tracked sets with a small batch stay irrelevant', () => {
    const root = mount('<div id="tick"></div>');
    expect(mutationTouchesTracked([attrRecord(root.querySelector('#tick')!)], [[]])).toBe(false);
  });
});
