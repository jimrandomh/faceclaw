#!/usr/bin/env python3
"""Locate the LVGL font descriptors that app/g2/firmware-fonts.ts extracts.

Usage: scripts/find-firmware-fonts.py <stock EVENOTA .bin> [<another .bin>...]

Scans the main-app component (ota/s200_firmware_ota.bin, loaded at 0x438000
after a 0x20-byte preamble) for lv_font_fmt_txt_dsc_t structs with 4 bpp,
bitmap format 3 and a plausible cmap table, and prints one row per font. After
a firmware rebase, match rows to FONT_SPECS by cmap count / code-point count
(the EvenHub fallback chain is n=12/8081, n=9/9566, n=4/11590) and copy the
new `dsc` addresses into firmware-fonts.ts.
"""
import struct, sys
BASE=0x438000
def mainapp(path):
    d=open(path,'rb').read()
    for i in range(8):
        toc=0x40+i*16; off=struct.unpack_from('<I',d,toc+4)[0]
        if not off or off>len(d): continue
        size=struct.unpack_from('<I',d,off+8)[0]
        name=d[off+48:off+128].split(b'\0')[0]
        if name==b'ota/s200_firmware_ota.bin':
            p=off+128+0x20; return d[p:p+size-0x20]
class Img:
    def __init__(s,b): s.b=b; s.end=BASE+len(b)
    def ok(s,a,n=4): return BASE<=a and a+n<=s.end
    def u32(s,a): return struct.unpack_from('<I',s.b,a-BASE)[0]
    def u16(s,a): return struct.unpack_from('<H',s.b,a-BASE)[0]
    def i16(s,a): return struct.unpack_from('<h',s.b,a-BASE)[0]
def find_dscs(img):
    out=[]
    for off in range(0,len(img.b)-20,4):
        a=BASE+off
        bm,gd,cm,kd=struct.unpack_from('<IIII',img.b,off)
        if not(img.ok(bm) and img.ok(gd) and img.ok(cm)): continue
        if kd!=0 and not img.ok(kd): continue
        packed=img.u16(a+18); n=packed&0x1ff; bpp=(packed>>9)&0xf; fmt=(packed>>14)&3
        if bpp!=4 or fmt!=3 or n==0 or n>64: continue
        # cmap entries 20 bytes: range_start u32, range_length u16, glyph_id_start u16, list ptr, list ptr, list_length u16, type u8
        good=True; total=0
        for i in range(n):
            c=cm+i*20
            if not img.ok(c,20): good=False;break
            rs=img.u32(c); rl=img.u16(c+4); t=img.b[c-BASE+19]
            if t>3 or rl==0 or rs>0x10FFFF: good=False;break
            total+=rl
        if not good: continue
        out.append((a,bm,gd,cm,kd,n,total))
    return out
for path in sys.argv[1:]:
    print("==",path); img=Img(mainapp(path))
    for a,bm,gd,cm,kd,n,total in find_dscs(img):
        print(f"dsc 0x{a:08x} bitmap 0x{bm:08x} glyphs 0x{gd:08x} cmaps 0x{cm:08x} n={n} codepoints={total}")
