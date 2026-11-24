import struct, zlib, os

SIZE = 32
PX = [[(0, 0, 0, 0)] * SIZE for _ in range(SIZE)]

PURPLE = (145, 71, 255, 255)   # #9147FF
DARK   = (94, 46, 175, 255)    # обводка

def rounded_rect(x0, y0, x1, y1, r):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            # внутри скруглённого прямоугольника?
            dx = max(x0 + r - x, 0, x - (x1 - r))
            dy = max(y0 + r - y, 0, y - (y1 - r))
            if dx * dx + dy * dy <= r * r + 1:
                PX[y][x] = PURPLE

# пузырь
rounded_rect(2, 3, 29, 24, 7)
# хвост (треугольник вниз-влево)
for y in range(23, 31):
    w = (y - 23) * 1.1
    for x in range(6, 14):
        if x <= 6 + w + 2 and y <= 23 + (x - 6) * 0.9:
            PX[y][x] = PURPLE
# мягкий хвост проще: клин
for i, y in enumerate(range(24, 30)):
    for x in range(7, 13 - i):
        PX[y][x] = PURPLE

# три белых точки
for cx in (11, 16, 21):
    for y in range(12, 17):
        for x in range(cx - 2, cx + 3):
            if (x - cx) ** 2 + (y - 14) ** 2 <= 4.5:
                PX[y][x] = (255, 255, 255, 255)

# склейка PNG (RGBA, no interlace)
raw = b''
for y in range(SIZE):
    raw += b'\x00' + b''.join(bytes(PX[y][x]) for x in range(SIZE))

def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9))
png += chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(__file__), '..', 'assets', 'tray.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'wb') as f:
    f.write(png)
print('written', os.path.abspath(out), len(png), 'bytes')
