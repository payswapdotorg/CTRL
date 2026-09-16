#!/usr/bin/env python3
"""Generate the Session Watchdog icons (emerald shield + pulse line).

A simple, high-contrast mark: dark rounded square, emerald heartbeat
(pulse/keepalive) line across the middle. No anti-aliasing subtleties —
drawn at 512 and downscaled with LANCZOS.
"""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE  # this script lives in icons/
os.makedirs(OUT, exist_ok=True)

BG = (16, 18, 20, 255)        # near-black
BG_EDGE = (52, 211, 153, 255) # emerald frame
PULSE = (52, 211, 153, 255)   # emerald line

S = 512

def base_image():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = 96
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=r, fill=BG)
    # emerald frame (double stroke look)
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=r, outline=BG_EDGE, width=14)
    return img, d

def draw_pulse(d, w, cx, cy):
    """The heartbeat/keepalive polyline, scaled to icon width w."""
    # normalized points (x in 0..1, y in -1..1)
    pts_norm = [
        (0.00, 0.00), (0.18, 0.00), (0.28, -0.34), (0.38, 0.52),
        (0.48, -0.86), (0.58, 0.62), (0.68, -0.30), (0.78, 0.00),
        (1.00, 0.00),
    ]
    x0 = cx - w / 2
    amp = w * 0.28
    pts = [(x0 + px * w, cy + py * amp) for (px, py) in pts_norm]
    d.line(pts, fill=PULSE, width=max(8, int(w * 0.075)), joint="curve")
    # round caps
    r = max(4, int(w * 0.037))
    for (px, py) in (pts[0], pts[-1]):
        d.ellipse([px - r, py - r, px + r, py + r], fill=PULSE)

img, d = base_image()
draw_pulse(d, w=S * 0.72, cx=S / 2, cy=S / 2)
img.save(os.path.join(OUT, "icon512.png"))

for size in (16, 32, 48, 128):
    im = img.resize((size, size), Image.LANCZOS)
    im.save(os.path.join(OUT, f"icon{size}.png"))
    print(f"icon{size}.png written")

# also emit the manifest icon list is fixed; done
print("icons done")
