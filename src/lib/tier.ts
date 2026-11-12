// Render tier: how much the page may spend on decoration.
//   software  no GPU (software rasteriser, or no WebGL at all): cheap scene, no blur
//   hardware  a real GPU: all effects on
//   reduced   the visitor asked for less motion (or less data): a still first frame
// The tier lives on <html data-tier="...">; CSS keys everything expensive (blur) off it.
// ?tier=software|hardware|reduced forces one for testing.

export type Tier = 'software' | 'hardware' | 'reduced';

const SOFTWARE = /swiftshader|llvmpipe|software|basic render/i;
const TIERS: Tier[] = ['software', 'hardware', 'reduced'];

let current: Tier | null = null;
let forced = false;

const query = () => {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
};

export function rendererString(gl?: WebGLRenderingContext | null): string {
  if (!gl) return 'none';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(r || 'unknown');
  } catch {
    return 'unknown';
  }
}

function probeRenderer(): string {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: false }) as WebGLRenderingContext | null;
    if (!gl) return 'none';
    const r = rendererString(gl);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return r;
  } catch {
    return 'none';
  }
}

function wantsLess(): boolean {
  const q = query();
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    if (q.get('motion') === 'off') return true;
    if (sessionStorage.getItem('motion') === 'off') return true;
  } catch {
    /* storage blocked: the other signals stand */
  }
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!conn?.saveData;
}

export function setTier(t: Tier) {
  current = t;
  document.documentElement.dataset.tier = t;
}

export const getTier = (): Tier => current ?? detectTier();

// Pass the live context when there is one; otherwise a throwaway context is asked.
export function detectTier(gl?: WebGLRenderingContext | null): Tier {
  const ask = query().get('tier');
  let t: Tier;
  if (ask && (TIERS as string[]).includes(ask)) {
    forced = true;
    t = ask as Tier;
  } else if (wantsLess()) {
    t = 'reduced';
  } else {
    const r = gl ? rendererString(gl) : probeRenderer();
    t = r === 'none' || SOFTWARE.test(r) ? 'software' : 'hardware';
  }
  setTier(t);
  return t;
}

// 90-frame runtime probe: a GPU that cannot hold ~30 fps is treated as software from then on.
// Feed it every frame interval (ms); it fires once and never on a forced or still tier.
// The first `warmFrames` frames after creation (and after reset) are ignored: shader compile,
// image decode and texture upload would otherwise demote a healthy GPU for good.
export function createTierProbe(frames = 90, demoteAboveMs = 33, warmFrames = 45) {
  let n = 0;
  let sum = 0;
  let warm = warmFrames;
  let done = false;
  return {
    sample(dtMs: number): Tier | null {
      if (done || forced || current !== 'hardware') return null;
      if (warm > 0) {
        warm--;
        return null;
      }
      sum += Math.min(dtMs, 100);
      if (++n < frames) return null;
      done = true;
      if (sum / n > demoteAboveMs) {
        setTier('software');
        return 'software';
      }
      return null;
    },
    reset() {
      n = 0;
      sum = 0;
      warm = warmFrames;
    },
  };
}
