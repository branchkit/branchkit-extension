export type { PlacementStrategy } from './strategy';
export { RangoStrategy } from './rango';

import { PlacementStrategy } from './strategy';
import { RangoStrategy } from './rango';
import { ElementWrapper } from '../scan/element-wrapper';

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

export { leaderLineGeometry } from './geometry';
