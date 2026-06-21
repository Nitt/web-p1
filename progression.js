/**
 * progression.js — background level pre-generation and worker management.
 *
 * Owns the Web Worker, the pending-level promise, and the generation-ID
 * counter that detects and discards stale worker responses.
 *
 * Exported API:
 *   pregenNext(seed, id, recipe)  — fire off a background generation
 *   takePendingLevel()            — consume the pending promise (returns it and clears it)
 *   getPendingRecipe()            — recipe used for the current pending generation
 */

import { generateHardestLevel } from './generator.js';

export const LEVEL_WIDTH  = 10;
export const LEVEL_HEIGHT = 8;

const _worker = new Worker(new URL('./levelWorker.js', import.meta.url), { type: 'module' });
_worker.onerror = (e) => console.error('[progression] worker error:', e.message, e);

let _pendingLevel  = null;   // Promise<level | null>
let _pendingRecipe = null;   // recipe used for the pending pre-generation
let _genId         = 0;      // incremented on every pregenNext call

/**
 * Start generating the next level in the background.
 * Any in-flight generation is superseded; its result will be silently dropped.
 */
export function pregenNext(seed, id, recipe) {
  _pendingRecipe = recipe;
  const genId = ++_genId;

  _pendingLevel = new Promise(resolve => {
    function handler({ data }) {
      _worker.removeEventListener('message', handler);
      // Drop the result if a newer generation has since been requested.
      resolve(data?.genId === genId ? data.level : null);
    }
    _worker.addEventListener('message', handler);
  });

  _worker.postMessage({
    genId,
    width:            LEVEL_WIDTH,
    height:           LEVEL_HEIGHT,
    seed,
    id,
    candidates:       recipe.candidates,
    weights:          recipe.weights,
    useTeleporter:    recipe.useTeleporter,
    difficultyTarget: recipe.difficultyTarget,
    entrySlide:       recipe.entrySlide ?? null,
    playerGears:      recipe.playerGears,
    maxUniverseBits:  recipe.maxUniverseBits ?? Infinity,
  });
}

/**
 * Consume the pending promise.  After this call _pendingLevel is null.
 * Returns a Promise that resolves to the generated level (or null on failure).
 */
export function takePendingLevel() {
  const p = _pendingLevel;
  _pendingLevel = null;
  return p;
}

/** The recipe used for the current (or most recent) pending generation. */
export function getPendingRecipe() {
  return _pendingRecipe;
}

/**
 * Synchronous fallback: generate a level on the main thread with a reduced
 * candidate count.  Used when the worker result is unavailable.
 */
export function generateFallback(seed, id, recipe) {
  return generateHardestLevel(LEVEL_WIDTH, LEVEL_HEIGHT, { seed, id, ...recipe });
}
