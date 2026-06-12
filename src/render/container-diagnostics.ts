/**
 * Diagnostic mirror of the container-resolution walk, for debug snapshots.
 * Re-runs the resolution with full tracing (every clip ancestor, its space,
 * whether escalation happened/was blocked) so a mis-anchored badge can be
 * decomposed from a snapshot without reproducing live.
 */

import { getCachedRect, getCachedStyle, isClipAncestor } from '../layout-cache';
import {
  findBadgeContainer,
  findLimitParent,
  isScrollContainer,
  getSpaceInAncestor,
  ENOUGH_LEFT,
  ENOUGH_TOP,
} from './container-resolution';

export interface ContainerResolutionDiag {
  limitParent: { tag: string; id: string; classes: string; position: string; isScrollContainer: boolean };
  clipAncestors: Array<{ tag: string; id: string; classes: string; space: { left: number; top: number }; tight: boolean }>;
  escalated: boolean;
  escalationBlocked: boolean;
  finalContainer: { tag: string; id: string; classes: string };
}

function elSig(el: Element): { tag: string; id: string; classes: string } {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: (typeof el.className === 'string' ? el.className : '').slice(0, 200),
  };
}

export function diagnoseContainerResolution(target: Element): ContainerResolutionDiag {
  const candidate = findBadgeContainer(target);
  const limitParent = findLimitParent(target);
  const targetRect = getCachedRect(target);
  const lpStyle = getCachedStyle(limitParent);

  const clipAncestors: ContainerResolutionDiag['clipAncestors'] = [];
  let current: Element | null = target.parentElement;
  let firstTightClip: HTMLElement | null = null;

  while (current && current !== limitParent && current !== document.body) {
    if (current instanceof HTMLElement && isClipAncestor(current)) {
      const space = getSpaceInAncestor(current, targetRect);
      const tight = space.left < ENOUGH_LEFT || space.top < ENOUGH_TOP;
      clipAncestors.push({ ...elSig(current), space, tight });
      if (tight) firstTightClip ??= current;
    }
    current = current.parentElement;
  }

  let escalated = false;
  let escalationBlocked = false;
  let finalContainer = candidate;

  if (firstTightClip) {
    const clipParent = firstTightClip.parentElement;
    if (clipParent instanceof HTMLElement && limitParent.contains(clipParent)) {
      finalContainer = clipParent;
      escalated = true;
    } else {
      const escaped = findBadgeContainer(firstTightClip);
      if (limitParent.contains(escaped)) {
        finalContainer = escaped;
        escalated = true;
      } else {
        escalationBlocked = true;
      }
    }
  }

  return {
    limitParent: {
      ...elSig(limitParent),
      position: lpStyle.position,
      isScrollContainer: isScrollContainer(limitParent),
    },
    clipAncestors,
    escalated,
    escalationBlocked,
    finalContainer: elSig(finalContainer),
  };
}
