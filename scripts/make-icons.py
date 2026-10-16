"""Generate the EE Connections app/tray icons into assets/.

    python scripts/make-icons.py

Draws a teal lightning bolt on a dark rounded square (the app's colors),
rendering each size separately with 4x supersampling so small tray sizes
stay sharp. Needs only numpy + matplotlib.
"""
import io
import struct
from pathlib import Path

import numpy as np
from matplotlib.image import imsave
from matplotlib.path import Path as MplPath

OUT = Path(__file__).resolve().parent.parent / "assets"
BG = np.array([0x0F, 0x34, 0x60]) / 255.0      # app background blue
BG_EDGE = np.array([0x1A, 0x1A, 0x2E]) / 255.0  # gradient end
BOLT = np.array([0x64, 0xFF, 0xDA]) / 255.0     # app accent teal

# Lightning bolt in unit coordinates (0..1, y down). Kept wide so it reads at 16 px.
BOLT_POLY = MplPath([
    (0.60, 0.06), (0.20, 0.56), (0.46, 0.56), (0.36, 0.94),
    (0.82, 0.40), (0.54, 0.40), (0.66, 0.06), (0.60, 0.06),
])


def render(size, ss=4):
    n = size * ss
    c = (np.arange(n) + 0.5) / n
    x, y = np.meshgrid(c, c)

    # Rounded square with corner radius 22% of the side.
    r, m = 0.22, 0.02
    dx = np.maximum(np.maximum(m + r - x, x - (1 - m - r)), 0)
    dy = np.maximum(np.maximum(m + r - y, y - (1 - m - r)), 0)
    inside = (x >= m) & (x <= 1 - m) & (y >= m) & (y <= 1 - m) & (dx**2 + dy**2 <= r**2)

    bolt = BOLT_POLY.contains_points(np.column_stack([x.ravel(), y.ravel()])).reshape(n, n)

    t = ((x + y) / 2)[..., None]
    rgb = BG * (1 - t) + BG_EDGE * t
    rgb = np.where(bolt[..., None], BOLT, rgb)
    alpha = inside.astype(float)

    rgba = np.dstack([rgb, alpha]).reshape(size, ss, size, ss, 4)
    # Premultiplied downsample so edges don't pick up dark fringes.
    a = rgba[..., 3:4]
    col = (rgba[..., :3] * a).mean(axis=(1, 3))
    alpha = a.mean(axis=(1, 3))
    col = np.where(alpha > 0, col / np.maximum(alpha, 1e-9), 0)
    return np.clip(np.dstack([col, alpha]), 0, 1)


def png_bytes(img):
    buf = io.BytesIO()
    imsave(buf, img, format="png")
    return buf.getvalue()


def write_ico(path, sizes):
    images = [png_bytes(render(s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for s, data in zip(sizes, images):
        dim = 0 if s >= 256 else s  # 0 means 256 in ICO
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    path.write_bytes(header + entries + blobs)


def main():
    OUT.mkdir(exist_ok=True)
    # Windows icon for the installer, window and tray.
    write_ico(OUT / "icon.ico", [16, 20, 24, 32, 40, 48, 64, 128, 256])
    # PNGs for macOS/Linux builds and non-Windows trays (@2x for HiDPI).
    imsave(OUT / "icon.png", render(512))
    imsave(OUT / "tray.png", render(16))
    imsave(OUT / "tray@2x.png", render(32))
    print(f"Wrote icons to {OUT}")


if __name__ == "__main__":
    main()
