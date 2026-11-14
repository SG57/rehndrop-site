// The scene ships two plate sets: landscape (room-<essence>.webp, mask-<essence>.png) and portrait
// (the same names with -p). Exactly one set is fetched, chosen by the viewport aspect at start; a later
// crossing of the threshold (rotate, resize, split-screen) swaps to the other set inside the engine.
import { PLATE_ASPECT, PLATE_ASPECT_P, PORTRAIT_BELOW, PORTRAIT_HYST } from './scene-config';

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

// portrait set when the viewport is taller than wide; ?plates=p|l forces a set (debug).
// `current` is the set already in use: it is kept inside a small band around the threshold, so a window
// held near square does not swap back and forth (each swap fetches and uploads six images).
export function pickSet(width: number, height: number, override?: string | null, current?: SetKey): SetKey {
  if (override === 'p' || override === 'l') return override;
  const aspect = width / Math.max(1, height);
  // stay in the current set until the aspect is clearly past the threshold on the far side
  if (current === 'l' && aspect > PORTRAIT_BELOW - PORTRAIT_HYST) return 'l'; // landscape until clearly portrait (< 0.94)
  if (current === 'p' && aspect < PORTRAIT_BELOW + PORTRAIT_HYST) return 'p'; // portrait until clearly landscape (> 1.06)
  return aspect < PORTRAIT_BELOW ? 'p' : 'l';
}
