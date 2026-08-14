"""Generate SpotShell Windows app icons (PNG + multi-size ICO)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = Path(__file__).resolve().parents[1] / 'resources'

# Brand colors from packages/desktop renderer theme
BG_TOP = (22, 28, 42)
BG_BOT = (12, 14, 20)
ACCENT = (91, 140, 255)
ACCENT_SOFT = (122, 162, 255)
CURSOR = (91, 214, 162)


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
  mask = Image.new('L', (size, size), 0)
  draw = ImageDraw.Draw(mask)
  draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
  return mask


def make_icon(size: int) -> Image.Image:
  scale = 4 if size <= 64 else 2 if size <= 128 else 1
  canvas = size * scale
  img = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
  draw = ImageDraw.Draw(img)

  pad = max(1, int(canvas * 0.04))
  radius = int(canvas * 0.22)

  for y in range(canvas):
    t = y / max(1, canvas - 1)
    r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
    g = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
    b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
    draw.line([(0, y), (canvas, y)], fill=(r, g, b, 255))

  glow = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
  glow_draw = ImageDraw.Draw(glow)
  gx, gy = int(canvas * 0.72), int(canvas * 0.78)
  gr = int(canvas * 0.42)
  glow_draw.ellipse((gx - gr, gy - gr, gx + gr, gy + gr), fill=(*ACCENT, 55))
  glow = glow.filter(ImageFilter.GaussianBlur(radius=max(1, canvas // 12)))
  img = Image.alpha_composite(img, glow)
  draw = ImageDraw.Draw(img)

  inset = max(1, int(canvas * 0.03))
  draw.rounded_rectangle(
    (pad + inset, pad + inset, canvas - pad - inset - 1, canvas - pad - inset - 1),
    radius=max(1, radius - inset),
    outline=(*ACCENT, 70),
    width=max(1, canvas // 64),
  )

  stroke = max(2, int(canvas * 0.08))
  cx = int(canvas * 0.42)
  cy = int(canvas * 0.50)
  arm = int(canvas * 0.18)

  cw = int(canvas * 0.10)
  ch = int(canvas * 0.18)
  cx0 = cx + int(arm * 0.55)
  cy0 = cy - ch // 2

  glyph_glow = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
  glow_draw = ImageDraw.Draw(glyph_glow)
  glow_stroke = stroke + max(2, canvas // 20)
  glow_draw.line(
    [(cx - arm, cy - arm), (cx + int(arm * 0.35), cy)],
    fill=(*ACCENT, 120),
    width=glow_stroke,
  )
  glow_draw.line(
    [(cx + int(arm * 0.35), cy), (cx - arm, cy + arm)],
    fill=(*ACCENT, 120),
    width=glow_stroke,
  )
  glow_draw.rounded_rectangle(
    (cx0, cy0, cx0 + cw, cy0 + ch),
    radius=max(1, canvas // 40),
    fill=(*CURSOR, 90),
  )
  glyph_glow = glyph_glow.filter(ImageFilter.GaussianBlur(radius=max(1, canvas // 18)))
  img = Image.alpha_composite(img, glyph_glow)
  draw = ImageDraw.Draw(img)

  draw.line(
    [(cx - arm, cy - arm), (cx + int(arm * 0.35), cy)],
    fill=(*ACCENT_SOFT, 255),
    width=stroke,
  )
  draw.line(
    [(cx + int(arm * 0.35), cy), (cx - arm, cy + arm)],
    fill=(*ACCENT_SOFT, 255),
    width=stroke,
  )
  end_radius = max(1, stroke // 2)
  for point in ((cx - arm, cy - arm), (cx + int(arm * 0.35), cy), (cx - arm, cy + arm)):
    draw.ellipse(
      (
        point[0] - end_radius,
        point[1] - end_radius,
        point[0] + end_radius,
        point[1] + end_radius,
      ),
      fill=(*ACCENT_SOFT, 255),
    )

  draw.rounded_rectangle(
    (cx0, cy0, cx0 + cw, cy0 + ch),
    radius=max(1, canvas // 48),
    fill=(*CURSOR, 255),
  )

  final = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
  final.paste(img, (0, 0))
  final.putalpha(rounded_rect_mask(canvas, radius))

  if scale != 1:
    final = final.resize((size, size), Image.Resampling.LANCZOS)
  return final


def main() -> None:
  OUT_DIR.mkdir(parents=True, exist_ok=True)
  sizes = [16, 24, 32, 48, 64, 128, 256, 512]
  images = {size: make_icon(size) for size in sizes}

  images[512].save(OUT_DIR / 'icon.png', format='PNG')
  images[256].save(OUT_DIR / 'icon-256.png', format='PNG')
  images[32].save(OUT_DIR / 'icon-32.png', format='PNG')

  ico_sizes = [16, 24, 32, 48, 64, 128, 256]
  ico_images = [images[size] for size in ico_sizes]
  ico_images[-1].save(
    OUT_DIR / 'icon.ico',
    format='ICO',
    sizes=[(size, size) for size in ico_sizes],
    append_images=ico_images[:-1],
  )

  print('wrote:', sorted(path.name for path in OUT_DIR.iterdir()))


if __name__ == '__main__':
  main()
