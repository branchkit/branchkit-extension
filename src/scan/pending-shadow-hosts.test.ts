/**
 * BranchKit Browser — pending-shadow-hosts unit tests.
 *
 * Pins the park/consume contract drainDiscovery relies on: a root that is or
 * contains a parked host forces the discovery walk even when the light-DOM
 * pre-filter sees nothing hintable.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addPendingShadowHost,
  consumePendingShadowHostsIn,
  _clearPendingShadowHostsForTests,
} from './pending-shadow-hosts';

beforeEach(() => {
  _clearPendingShadowHostsForTests();
});

describe('consumePendingShadowHostsIn', () => {
  it('empty set — false, cheap', () => {
    expect(consumePendingShadowHostsIn(document.createElement('div'))).toBe(false);
  });

  it('root IS the parked host', () => {
    const host = document.createElement('div');
    addPendingShadowHost(host);
    expect(consumePendingShadowHostsIn(host)).toBe(true);
  });

  it('root contains the parked host', () => {
    const root = document.createElement('div');
    const host = document.createElement('div');
    root.appendChild(host);
    addPendingShadowHost(host);
    expect(consumePendingShadowHostsIn(root)).toBe(true);
  });

  it('unrelated root does not consume', () => {
    const host = document.createElement('div');
    addPendingShadowHost(host);
    expect(consumePendingShadowHostsIn(document.createElement('div'))).toBe(false);
    // Still parked — the containing root consumes it later.
    expect(consumePendingShadowHostsIn(host)).toBe(true);
  });

  it('consuming removes the entry (second consume is false)', () => {
    const host = document.createElement('div');
    addPendingShadowHost(host);
    expect(consumePendingShadowHostsIn(host)).toBe(true);
    expect(consumePendingShadowHostsIn(host)).toBe(false);
  });

  it('consumes every contained host in one pass', () => {
    const root = document.createElement('div');
    const a = document.createElement('div');
    const b = document.createElement('div');
    root.append(a, b);
    addPendingShadowHost(a);
    addPendingShadowHost(b);
    expect(consumePendingShadowHostsIn(root)).toBe(true);
    expect(consumePendingShadowHostsIn(a)).toBe(false);
    expect(consumePendingShadowHostsIn(b)).toBe(false);
  });
});
