import { ElementWrapper } from '../scan/element-wrapper';

export interface PlacementStrategy {
  name: string;
  placeAll(wrappers: ElementWrapper[]): void;
  placeOne(wrapper: ElementWrapper, readingIndex: number): void;
  clear(): void;
}
