import type { BenchTest } from '../test';
import { actors1000, actors4000 } from './actors';
import { stackRealistic100Settle, stackRealisticRest, stackRealisticSettle } from './stack-realistic';
import { arcadeBouncing } from './arcade-bouncing';
import { edgeFloor } from './edge-floor';
import { sleepingPileWake } from './sleeping-pile';
import { bunnymark2000, bunnymark5000 } from './bunnymark';
import { actorHierarchy, compositeColliders, tilemapLayers, topDownGame } from './game-scenes';

/**
 * All benchmark scenarios, in the order they are reported. Add new ones here.
 */
export const tests: BenchTest[] = [
  actors1000,
  actors4000,
  stackRealistic100Settle,
  stackRealisticSettle,
  stackRealisticRest,
  arcadeBouncing,
  edgeFloor,
  sleepingPileWake,
  bunnymark2000,
  bunnymark5000,
  tilemapLayers,
  actorHierarchy,
  compositeColliders,
  topDownGame
];
