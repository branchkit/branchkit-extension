import { describe, it, expect, beforeEach } from 'vitest';
import { accessibleName } from './accessible-name';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('accessibleName', () => {
  it('resolves aria-labelledby referenced element text', () => {
    document.body.innerHTML = `
      <span id="lbl">Compose Mail</span>
      <button aria-labelledby="lbl">X</button>
    `;
    const btn = document.querySelector('button')!;
    expect(accessibleName(btn)).toBe('Compose Mail');
  });

  it('concatenates multiple space-separated aria-labelledby IDs', () => {
    document.body.innerHTML = `
      <span id="a">First</span>
      <span id="b">Second</span>
      <button aria-labelledby="a b">X</button>
    `;
    const btn = document.querySelector('button')!;
    expect(accessibleName(btn)).toBe('First Second');
  });

  it('prevents infinite recursion on aria-labelledby cycles', () => {
    document.body.innerHTML = `
      <span id="a" aria-labelledby="b">A</span>
      <span id="b" aria-labelledby="a">B</span>
    `;
    const a = document.getElementById('a')!;
    // Cycle: a→b→a(blocked), falls back to a.innerText="A" for b's resolution
    expect(accessibleName(a)).toBe('A');
  });

  it('uses aria-label when no labelledby', () => {
    document.body.innerHTML = `<button aria-label="Close dialog">X</button>`;
    const btn = document.querySelector('button')!;
    expect(accessibleName(btn)).toBe('Close dialog');
  });

  it('aria-labelledby takes priority over aria-label', () => {
    document.body.innerHTML = `
      <span id="lbl">From label</span>
      <button aria-labelledby="lbl" aria-label="From attr">X</button>
    `;
    const btn = document.querySelector('button')!;
    expect(accessibleName(btn)).toBe('From label');
  });

  it('input with associated <label> elements', () => {
    document.body.innerHTML = `
      <label for="email">Email Address</label>
      <input id="email" type="text" />
    `;
    const input = document.querySelector('input')!;
    expect(accessibleName(input)).toBe('Email Address');
  });

  it('input[type=submit] uses value', () => {
    document.body.innerHTML = `<input type="submit" value="Send" />`;
    const input = document.querySelector('input')!;
    expect(accessibleName(input)).toBe('Send');
  });

  it('input[type=submit] falls back to type name', () => {
    document.body.innerHTML = `<input type="submit" />`;
    const input = document.querySelector('input')!;
    expect(accessibleName(input)).toBe('submit');
  });

  it('input placeholder as last resort for inputs', () => {
    document.body.innerHTML = `<input type="text" placeholder="Search..." />`;
    const input = document.querySelector('input')!;
    expect(accessibleName(input)).toBe('Search...');
  });

  it('img alt text', () => {
    document.body.innerHTML = `<img alt="Company Logo" src="logo.png" />`;
    const img = document.querySelector('img')!;
    expect(accessibleName(img)).toBe('Company Logo');
  });

  it('img falls back to title when no alt', () => {
    document.body.innerHTML = `<img title="Decorative" src="bg.png" />`;
    const img = document.querySelector('img')!;
    expect(accessibleName(img)).toBe('Decorative');
  });

  it('fieldset/legend extraction', () => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Personal Info</legend>
        <input type="text" />
      </fieldset>
    `;
    const fieldset = document.querySelector('fieldset')!;
    expect(accessibleName(fieldset)).toBe('Personal Info');
  });

  it('SVG <title> piercing for icon buttons', () => {
    document.body.innerHTML = `
      <button>
        <svg><title>Menu</title><path d="M0 0h24v24H0z"/></svg>
      </button>
    `;
    const btn = document.querySelector('button')!;
    expect(accessibleName(btn)).toBe('Menu');
  });

  it('name-from-content roles use innerText', () => {
    document.body.innerHTML = `<a href="/home">Go Home</a>`;
    const link = document.querySelector('a')!;
    expect(accessibleName(link)).toBe('Go Home');
  });

  it('heading uses innerText', () => {
    document.body.innerHTML = `<h1>Welcome</h1>`;
    const h1 = document.querySelector('h1')!;
    expect(accessibleName(h1)).toBe('Welcome');
  });

  it('role=button uses innerText', () => {
    document.body.innerHTML = `<div role="button">Click Me</div>`;
    const el = document.querySelector('[role=button]')!;
    expect(accessibleName(el)).toBe('Click Me');
  });

  it('container suppression: nav returns title only, not descendant text', () => {
    document.body.innerHTML = `
      <nav title="Main menu">
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
      </nav>
    `;
    const nav = document.querySelector('nav')!;
    expect(accessibleName(nav)).toBe('Main menu');
  });

  it('container with no title or aria-label returns empty string', () => {
    document.body.innerHTML = `
      <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
      </nav>
    `;
    const nav = document.querySelector('nav')!;
    expect(accessibleName(nav)).toBe('');
  });

  it('container suppression applies to role-based containers', () => {
    document.body.innerHTML = `
      <div role="navigation">
        <a href="/">Home</a>
        <a href="/about">About</a>
      </div>
    `;
    const el = document.querySelector('[role=navigation]')!;
    expect(accessibleName(el)).toBe('');
  });

  it('table container suppression', () => {
    document.body.innerHTML = `
      <table title="Sales data">
        <tr><td>Revenue</td><td>$100</td></tr>
      </table>
    `;
    const table = document.querySelector('table')!;
    expect(accessibleName(table)).toBe('Sales data');
  });

  it('title attribute as fallback for generic elements', () => {
    document.body.innerHTML = `<div title="Tooltip text">...</div>`;
    const el = document.querySelector('div')!;
    expect(accessibleName(el)).toBe('Tooltip text');
  });

  it('aria-describedby as name-of-last-resort', () => {
    document.body.innerHTML = `
      <span id="desc">Opens in new window</span>
      <div aria-describedby="desc"></div>
    `;
    const el = document.querySelector('[aria-describedby]')!;
    expect(accessibleName(el)).toBe('Opens in new window');
  });

  it('plain innerText capped at 256 chars', () => {
    const long = 'a'.repeat(300);
    document.body.innerHTML = `<div>${long}</div>`;
    const el = document.querySelector('div')!;
    expect(accessibleName(el).length).toBe(256);
  });

  it('normalizes whitespace across all paths', () => {
    document.body.innerHTML = `<button aria-label="  hello   world  ">X</button>`;
    expect(accessibleName(document.querySelector('button')!)).toBe('hello world');
  });

  it('returns empty for null/undefined attributes', () => {
    document.body.innerHTML = `<div></div>`;
    const el = document.querySelector('div')!;
    expect(accessibleName(el)).toBe('');
  });
});
