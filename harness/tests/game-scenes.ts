import { defineTest, type BenchContext, type BenchTest, type Ex } from '../test';

/**
 * Scenes shaped like a game rather than a stress test of one system: tile map layers under a moving camera, actors
 * with children, composite colliders. Whatever moves does so from an overridden onPostUpdate, the way game code does,
 * so no scene subscribes to any engine event. They run long enough for the slowest 1% of the steps to mean something.
 */

const WIDTH = 1280;
const HEIGHT = 720;
const CELL = 32;
const FRAMES = 1200;
// a cold page is still compiling through the first few hundred steps
const WARMUP = 300;

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const SCREEN: Bounds = { left: 0, top: 0, right: WIDTH, bottom: HEIGHT };

const engineOptions = () => ({ width: WIDTH, height: HEIGHT, pixelRatio: 1 });

/**
 * 64 distinct 32x32 sprites from one generated sheet
 */
async function makeSprites(ex: Ex): Promise<Ex[]> {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * 8;
  canvas.height = CELL * 8;
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < 64; i++) {
    const x = (i % 8) * CELL;
    const y = Math.floor(i / 8) * CELL;
    ctx.fillStyle = `hsl(${(i * 47) % 360} 60% ${35 + (i % 4) * 10}%)`;
    ctx.fillRect(x, y, CELL, CELL);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(x + 4, y + 4, CELL - 8, CELL - 8);
  }
  const image = new ex.ImageSource(canvas.toDataURL());
  await image.load();
  return ex.SpriteSheet.fromImageSource({
    image,
    grid: { rows: 8, columns: 8, spriteWidth: CELL, spriteHeight: CELL }
  }).sprites;
}

const pick = (rng: Ex, sprites: Ex[]) => sprites[rng.integer(0, sprites.length - 1)];

const moverClasses = new WeakMap<object, Ex>();

/**
 * An actor that bounces around its `bounds` from its own onPostUpdate. One class per engine bundle, as a game has:
 * a class per actor would make the engine's call sites megamorphic
 */
function moverClass(ex: Ex): Ex {
  let Mover = moverClasses.get(ex);
  if (!Mover) {
    Mover = class extends ex.Actor {
      bounds: Bounds = SCREEN;

      onPostUpdate() {
        const { pos, vel, bounds } = this as unknown as { pos: Ex; vel: Ex; bounds: Bounds };
        if ((pos.x < bounds.left && vel.x < 0) || (pos.x > bounds.right && vel.x > 0)) {
          vel.x = -vel.x;
        }
        if ((pos.y < bounds.top && vel.y < 0) || (pos.y > bounds.bottom && vel.y > 0)) {
          vel.y = -vel.y;
        }
      }
    };
    moverClasses.set(ex, Mover);
  }
  return Mover;
}

function addMover(ctx: BenchContext, sprites: Ex[], bounds: Bounds): Ex {
  const { ex, engine, rng } = ctx;
  const Mover = moverClass(ex);
  const mover = new Mover({
    pos: ex.vec(rng.floating(bounds.left, bounds.right), rng.floating(bounds.top, bounds.bottom)),
    vel: ex.vec(rng.floating(-80, 80), rng.floating(-80, 80))
  });
  mover.bounds = bounds;
  mover.graphics.use(pick(rng, sprites));
  engine.add(mover);
  return mover;
}

/**
 * Tile map layers covering a 120x80 cell world: a full ground layer, and layers above it 60% covered
 */
function addTileMaps(ctx: BenchContext, sprites: Ex[], layers: number): Bounds {
  const { ex, engine, rng } = ctx;
  const columns = 120;
  const rows = 80;
  for (let layer = 0; layer < layers; layer++) {
    const map = new ex.TileMap({ pos: ex.vec(0, 0), tileWidth: CELL, tileHeight: CELL, columns, rows });
    map.z = layer - layers;
    const fill = layer === 0 ? 1 : 0.6;
    for (const tile of map.tiles) {
      if (rng.next() < fill) {
        tile.addGraphic(pick(rng, sprites));
      }
    }
    engine.add(map);
  }
  return { left: 0, top: 0, right: columns * CELL, bottom: rows * CELL };
}

const drawnImages = ({ engine }: BenchContext) => ({ drawnImages: engine.stats?.prevFrame?.graphics?.drawnImages ?? NaN });

export const tilemapLayers: BenchTest = defineTest({
  name: 'tilemap-6-layers',
  description: '6 tile map layers of 120x80 cells under a camera following a moving actor (~960 tiles a layer on screen)',
  stepMs: 1000 / 60,
  warmup: WARMUP,
  frames: FRAMES,
  engineOptions,
  setup: async (ctx: BenchContext) => {
    const sprites = await makeSprites(ctx.ex);
    const world = addTileMaps(ctx, sprites, 6);
    ctx.engine.currentScene.camera.strategy.lockToActor(addMover(ctx, sprites, world));
  },
  extras: drawnImages
});

export const actorHierarchy: BenchTest = defineTest({
  name: 'actors-500x4-children',
  description: '500 moving actors with 4 child actors each, one child of each turning',
  stepMs: 1000 / 60,
  warmup: WARMUP,
  frames: FRAMES,
  engineOptions,
  setup: async (ctx: BenchContext) => {
    const { ex, rng } = ctx;
    const sprites = await makeSprites(ex);
    for (let i = 0; i < 500; i++) {
      const parent = addMover(ctx, sprites, SCREEN);
      for (let c = 0; c < 4; c++) {
        const child = new ex.Actor({ pos: ex.vec((c - 1.5) * 12, -20 - c * 4), scale: ex.vec(0.5, 0.5) });
        child.graphics.use(pick(rng, sprites));
        if (c === 0) {
          child.angularVelocity = 1;
        }
        parent.addChild(child);
      }
    }
  },
  extras: drawnImages
});

export const compositeColliders: BenchTest = defineTest({
  name: 'composite-colliders-1000',
  description: '1000 resting active bodies with a two-shape composite collider each, none touching another',
  stepMs: 1000 / 60,
  warmup: WARMUP,
  frames: FRAMES,
  engineOptions,
  setup: async (ctx: BenchContext) => {
    const { ex, engine, rng } = ctx;
    const sprites = await makeSprites(ex);
    const shapes = ex.Colliders ?? ex.Shape;
    for (let i = 0; i < 1000; i++) {
      const actor = new ex.Actor({ pos: ex.vec(16 + (i % 40) * CELL, 16 + Math.floor(i / 40) * CELL) });
      actor.graphics.use(pick(rng, sprites));
      actor.collider.useCompositeCollider([shapes.Box(12, 12), shapes.Circle(5, ex.vec(0, 8))]);
      actor.body.collisionType = ex.CollisionType.Active;
      engine.add(actor);
    }
  },
  extras: drawnImages
});

export const topDownGame: BenchTest = defineTest({
  name: 'top-down-300',
  description: '4 tile map layers and 300 moving characters, each with a box collider and 2 children, camera on one',
  stepMs: 1000 / 60,
  warmup: WARMUP,
  frames: FRAMES,
  engineOptions,
  setup: async (ctx: BenchContext) => {
    const { ex, engine, rng } = ctx;
    const sprites = await makeSprites(ex);
    const world = addTileMaps(ctx, sprites, 4);
    let first: Ex = null;
    for (let i = 0; i < 300; i++) {
      const character = addMover(ctx, sprites, world);
      character.collider.useBoxCollider(24, 32);
      character.body.collisionType = ex.CollisionType.Passive;
      for (let c = 0; c < 2; c++) {
        const child = new ex.Actor({ pos: ex.vec(0, c === 0 ? 14 : -24), scale: ex.vec(0.5, 0.25) });
        child.graphics.use(pick(rng, sprites));
        character.addChild(child);
      }
      first ??= character;
    }
    engine.currentScene.camera.strategy.lockToActor(first);
  },
  extras: drawnImages
});
