// The scene ships two plate sets: landscape (room-<essence>.webp, mask-<essence>.png) and portrait
// (the same names with -p). Exactly one set is fetched, chosen by the viewport aspect at start; a later
// crossing of the threshold (rotate, resize, split-screen) swaps to the other set inside the engine.
import { PLATE_ASPECT, PLATE_ASPECT_P, PORTRAIT_BELOW } from './scene-config';

export const SCENE_ESSENCES = ['candle', 'chrome', 'dawn'] as const;
export type SetKey = 'l' | 'p';
export interface SceneSet {
  plates: string[]; // candle, chrome, dawn
  masks: string[];
  aspect: number; // width / height of every plate in the set
}

export function sceneSets(url: (path: string) => string): Record<SetKey, SceneSet> {
  const set = (suffix: string, aspect: number): SceneSet => ({
    plates: SCENE_ESSENCES.map((n) => url(`scene/room-${n}${suffix}.webp`)),
    masks: SCENE_ESSENCES.map((n) => url(`scene/mask-${n}${suffix}.png`)),
    aspect,
  });
  return { l: set('', PLATE_ASPECT), p: set('-p', PLATE_ASPECT_P) };
}

// portrait set when the viewport is taller than wide; ?plates=p|l forces a set (debug)
export function pickSet(width: number, height: number, override?: string | null): SetKey {
  if (override === 'p' || override === 'l') return override;
  return width / Math.max(1, height) < PORTRAIT_BELOW ? 'p' : 'l';
}
