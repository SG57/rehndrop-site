"""Metric-matched fallback faces for the site's web fonts.

    python scripts/font_metrics.py            print the @font-face fallback blocks
    python scripts/font_metrics.py --check    exit 1 if src/styles/fonts.css disagrees with the font files

While a web font loads (font-display: swap) the browser draws the text in the next family in the stack,
then swaps. If that fallback is a different width or height the page jumps. A fallback face that names a
local system font and overrides size-adjust, ascent-override, descent-override and line-gap-override from the
real font files makes the first paint occupy the same space as the final one, so the swap moves nothing.

size-adjust is the ratio of the two fonts' mean advance width over English letter frequencies (the site's copy
is lowercase English; fonts are weighted by how often each letter occurs, space included). The vertical
overrides are the web font's hhea metrics divided by size-adjust (the browser scales the fallback by size-adjust,
so the overrides are stated in the scaled font's units). Needs fontTools (pip install fonttools brotli) and the
Windows Arial and Times New Roman files the fallbacks are measured against: they are the fonts the local()
sources name, and macOS ships the same metrics under those names.
"""
import os
import re
import sys
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
WIN = os.environ.get('WINDIR', r'C:\Windows') + r'\Fonts'
fontsource = lambda pkg, f: os.path.join(SITE, 'node_modules', pkg, 'files', f)

# letter frequency (per cent, standard English sample); space is about 18 per cent of running text
FREQ = dict(a=8.167, b=1.492, c=2.782, d=4.253, e=12.702, f=2.228, g=2.015, h=6.094, i=6.966, j=0.153, k=0.772,
            l=4.025, m=2.406, n=6.749, o=7.507, p=1.929, q=0.095, r=5.987, s=6.327, t=9.056, u=2.758, v=0.978,
            w=2.360, x=0.150, y=1.974, z=0.074)
FREQ[' '] = 18.0

# family name -> (web font file, fallback font file, fallback family, local() sources, style, the stacks that use it)
FACES = {
    'Michroma Fallback': (fontsource('@fontsource/michroma', 'michroma-latin-400-normal.woff2'),
                          os.path.join(WIN, 'arial.ttf'), 'Arial', ['Arial', 'Helvetica'], 'normal'),
    'Manrope Fallback': (fontsource('@fontsource-variable/manrope', 'manrope-latin-wght-normal.woff2'),
                         os.path.join(WIN, 'arial.ttf'), 'Arial', ['Arial', 'Helvetica'], 'normal'),
    'Instrument Serif Fallback': (fontsource('@fontsource/instrument-serif', 'instrument-serif-latin-400-italic.woff2'),
                                  os.path.join(WIN, 'timesi.ttf'), 'Times New Roman Italic',
                                  ['Times New Roman Italic', 'TimesNewRomanPS-ItalicMT', 'Times New Roman'], 'italic'),
}

# The rehndrop display face is derived from Michroma and keeps its advance widths and vertical metrics, so its
# stack shares 'Michroma Fallback'. --check fails if that stops being true.
SHARED = {'Michroma Fallback': os.path.join(SITE, 'src', 'assets', 'fonts', 'rehndrop-mix-focus.woff2')}

# Manrope is a variable font and the site asks for 400 to 700. A face that declares only 400 would be faux-bolded
# for the heavier weights and come out wider; declaring the whole range keeps the regular glyphs at every weight.
WEIGHT = {'Manrope Fallback': '200 800'}


def mean_advance(font):
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    upm = font['head'].unitsPerEm
    total = sum(FREQ.values())
    return sum(w * hmtx[cmap[ord(ch)]][0] / upm for ch, w in FREQ.items()) / total


def pct(x):
    return f'{x * 100:.2f}%'


def compute(name):
    web_path, fb_path, fb_name, local, style = FACES[name]
    web, fb = TTFont(web_path), TTFont(fb_path)
    adjust = mean_advance(web) / mean_advance(fb)
    upm = web['head'].unitsPerEm
    hh = web['hhea']
    return dict(name=name, local=local, style=style, size=adjust,
                ascent=hh.ascent / upm / adjust, descent=-hh.descent / upm / adjust, gap=hh.lineGap / upm / adjust)


def block(f):
    srcs = ', '.join(f"local('{n}')" for n in f['local'])
    weight = f"  font-weight: {WEIGHT[f['name']]};\n" if f['name'] in WEIGHT else ''
    return (f"@font-face {{\n  font-family: '{f['name']}';\n  font-style: {f['style']};\n{weight}  src: {srcs};\n"
            f"  size-adjust: {pct(f['size'])};\n  ascent-override: {pct(f['ascent'])};\n"
            f"  descent-override: {pct(f['descent'])};\n  line-gap-override: {pct(f['gap'])};\n}}")


def main():
    faces = [compute(n) for n in FACES]
    shared_bad = 0
    for name, path in SHARED.items():
        web_path, fb_path, _, local, style = FACES[name]
        FACES['shared'] = (path, fb_path, '', local, style)
        other = compute('shared')
        mine = next(f for f in faces if f['name'] == name)
        for key in ('size', 'ascent', 'descent', 'gap'):
            if abs(other[key] - mine[key]) > 0.0005:
                shared_bad += 1
                print(f"FAIL {path} no longer shares {name}: {key} {other[key] * 100:.2f}% vs {mine[key] * 100:.2f}%")
        del FACES['shared']
    if '--check' not in sys.argv:
        print('\n'.join(block(f) + '\n' for f in faces))
        return 0
    css = open(os.path.join(SITE, 'src', 'styles', 'fonts.css'), encoding='utf8').read()
    bad = 0
    for f in faces:
        m = re.search(r"@font-face\s*\{[^}]*font-family:\s*'%s';[^}]*\}" % re.escape(f['name']), css)
        if not m:
            print(f"FAIL {f['name']}: no @font-face in fonts.css")
            bad += 1
            continue
        for prop, key in (('size-adjust', 'size'), ('ascent-override', 'ascent'), ('descent-override', 'descent'), ('line-gap-override', 'gap')):
            got = re.search(prop + r':\s*([\d.]+)%', m.group(0))
            want = f[key] * 100
            if not got or abs(float(got.group(1)) - want) > 0.011:
                print(f"FAIL {f['name']} {prop}: fonts.css has {got.group(1) + '%' if got else 'nothing'}, the font files give {want:.2f}%")
                bad += 1
    bad += shared_bad
    print(f'FAIL: {bad} fallback metric(s) out of step with the font files' if bad else f'ok: {len(faces)} fallback faces match the font files, and rehndrop shares the Michroma one')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
