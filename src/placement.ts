export type { PlacementStrategy } from './placement/strategy';
export { RangoStrategy } from './placement/rango';

import { PlacementStrategy } from './placement/strategy';
import { RangoStrategy } from './placement/rango';
import { ElementWrapper } from './element-wrapper';

const strategies: Record<string, () => PlacementStrategy> = {
  rango: () => new RangoStrategy(),
};

let active: PlacementStrategy = new RangoStrategy();

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
