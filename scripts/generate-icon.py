from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SCALE = 4
SIZE = 1024


def scaled(point):
    return tuple(round(value * SCALE) for value in point)


def circle(draw, center, radius, fill):
    x, y = scaled(center)
    r = radius * SCALE
    draw.ellipse((x - r, y - r, x + r, y + r), fill=fill)


canvas = Image.new('RGBA', (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)

draw.rounded_rectangle(
    (*scaled((112, 112)), *scaled((912, 912))),
    radius=226 * SCALE,
    fill='#15243a',
)

slash_start = scaled((350, 704))
slash_end = scaled((674, 320))
slash_width = 112 * SCALE
draw.line((slash_start, slash_end), fill='#f6f7f4', width=slash_width)
circle(draw, (350, 704), 56, '#f6f7f4')
circle(draw, (674, 320), 56, '#f6f7f4')

circle(draw, (732, 690), 48, '#2c62d6')

canvas = canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
png_paths = [ROOT / 'desktop-src' / 'icon.png', ROOT / 'public' / 'icon.png']
for path in png_paths:
    canvas.save(path)

canvas.save(
    ROOT / 'desktop-src' / 'icon.ico',
    format='ICO',
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
