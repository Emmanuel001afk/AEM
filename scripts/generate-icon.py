#!/usr/bin/env python3
"""Deterministically rasterize the existing AEM launcher mark using only the stdlib."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "desktop" / "assets"
OUT.mkdir(parents=True, exist_ok=True)
RED = (240, 68, 68, 255)
WHITE = (255, 255, 255, 255)
A = [(29,79),(49,29),(59,29),(79,79),(67,79),(62,65),(46,65),(41,79)]
HOLE = [(49,56),(54,42),(59,56)]

def inside(x, y, polygon):
    result = False
    for i, (x1, y1) in enumerate(polygon):
        x2, y2 = polygon[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2-x1)*(y-y1)/(y2-y1)+x1:
            result = not result
    return result

def png(size):
    rows = []
    scale = 108 / size
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            votes = {}
            for sy in (0.25, 0.75):
                for sx in (0.25, 0.75):
                    x, y = (px+sx)*scale, (py+sy)*scale
                    dx, dy = max(28-x, x-80, 0), max(28-y, y-80, 0)
                    color = (0,0,0,0)
                    if dx*dx+dy*dy <= 144 and 16 <= x <= 92 and 16 <= y <= 92:
                        color = WHITE if inside(x,y,A) and not inside(x,y,HOLE) else RED
                    votes[color] = votes.get(color,0)+1
            color = max(votes, key=votes.get)
            if 0 < votes[color] < 4 and color[3]:
                color = (*color[:3], round(255*votes[color]/4))
            row.extend(color)
        rows.append(bytes(row))
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows),9))+chunk(b'IEND',b'')

sizes = [16,24,32,48,64,128,256]
images = {size:png(size) for size in sizes}
(OUT/'icon.png').write_bytes(images[256])
header = struct.pack('<HHH',0,1,len(sizes))
offset = 6+16*len(sizes)
entries, blobs = [], []
for size in sizes:
    data = images[size]
    entries.append(struct.pack('<BBBBHHII',size%256,size%256,0,0,1,32,len(data),offset))
    blobs.append(data)
    offset += len(data)
(OUT/'icon.ico').write_bytes(header+b''.join(entries)+b''.join(blobs))
print(f"Generated AEM PNG and {len(sizes)}-resolution ICO from the existing launcher geometry.")
