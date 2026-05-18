export type { PlacementStrategy } from './placement/strategy';
export { GreedyStrategy } from './placement/greedy';
export { RangoStrategy } from './placement/rango';
export { WhitespaceStrategy } from './placement/whitespace';

import { PlacementStrategy } from './placement/strategy';
import { GreedyStrategy } from './placement/greedy';
import { RangoStrategy } from './placement/rango';
import { WhitespaceStrategy } from './placement/whitespace';
import { ElementWrapper } from './element-wrapper';

const strategies: Record<string, () => PlacementStrategy> = {
  greedy: () => new GreedyStrategy(),
  rango: () => new RangoStrategy(),
  whitespace: () => new WhitespaceStrategy(),
};

let active: PlacementStrategy = new GreedyStrategy();

export function setPlacementStrategy(name: string): void {
  const factory = strategies[name];
  if (!factory) return;
  active.clear();
  active = factory();
}

export function getPlacementStrategyName(): string {
  return active.name;
}

export function listPlacementStrategies(): string[] {
  return Object.keys(strategies);
}

export function registerPlacementStrategy(name: string, factory: () => PlacementStrategy): void {
  strategies[name] = factory;
}

export function placeBadges(wrappers: ElementWrapper[]): void {
  active.placeAll(wrappers);
}

export function placeOne(wrapper: ElementWrapper, readingIndex: number): void {
  active.placeOne(wrapper, readingIndex);
}

export function clearPlacement(): void {
  active.clear();
}

export { leaderLineGeometry } from './placement/geometry';
