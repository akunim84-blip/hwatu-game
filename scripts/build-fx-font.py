#!/usr/bin/env python3
"""효과 글자(도장·배너)용 글꼴 만들기: Black Han Sans (OFL) → public/fonts/hyuk-fx.woff2
글자 모음 = KS X 1001 한글 2,350자 + 소스·음성 목록에 나오는 모든 글자(글꼴에 있는 것) + ASCII + 한글 자모.
겹친 윤곽선을 합쳐서(removeOverlaps) 외곽선이 조각나 보이지 않게 함.
사용: python3 -m venv /tmp/fv && /tmp/fv/bin/pip install fonttools brotli skia-pathops
      /tmp/fv/bin/python scripts/build-fx-font.py /path/to/BlackHanSans-Regular.ttf
원본: https://github.com/google/fonts/raw/main/ofl/blackhansans/BlackHanSans-Regular.ttf
"""
import glob, os, sys
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.ttLib.removeOverlaps import removeOverlaps

ROOT = os.path.join(os.path.dirname(__file__), '..')
src_font = sys.argv[1]
cmap = TTFont(src_font).getBestCmap()
chars = set(chr(c) for c in range(0x20, 0x7F))
chars |= set(bytes([a, b]).decode('euc-kr') for a in range(0xB0, 0xC9) for b in range(0xA1, 0xFF))  # KS X 1001 한글
chars |= set(chr(c) for c in range(0x3131, 0x3164))  # 자모
for p in glob.glob(os.path.join(ROOT, 'public', '*.js')) + glob.glob(os.path.join(ROOT, 'lib', '*.js')) + [os.path.join(ROOT, f) for f in ('server.js', 'public/index.html', 'public/voice/manifest.json')]:
    chars |= set(open(p, encoding='utf8').read())
keep = sorted(c for c in chars if ord(c) in cmap)
print('glyphs requested', len(chars), 'kept (in font)', len(keep), 'hangul', sum(0xAC00 <= ord(c) <= 0xD7A3 for c in keep))
opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['kern', 'liga']
opts.name_IDs = ['*']
opts.notdef_outline = True
font = TTFont(src_font)
sub = subset.Subsetter(opts)
sub.populate(unicodes=[ord(c) for c in keep])
sub.subset(font)
removeOverlaps(font)
out = os.path.join(ROOT, 'public', 'fonts', 'hyuk-fx.woff2')
font.flavor = 'woff2'
font.save(out)
print('wrote', out, os.path.getsize(out), 'bytes')
