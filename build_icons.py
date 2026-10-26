"""Render the extension's original archive mark; no downloaded image assets."""
from pathlib import Path
from PIL import Image, ImageDraw

folder = Path(__file__).resolve().parent / "edge-extension" / "icons"
folder.mkdir(exist_ok=True)
scale = 4
canvas = Image.new("RGBA", (128 * scale, 128 * scale))
draw = ImageDraw.Draw(canvas)
def points(values):
    return tuple(v * scale for v in values)
draw.rounded_rectangle(points((2, 2, 126, 126)), radius=28 * scale, fill="#a6e4cd")
draw.rounded_rectangle(points((28, 43, 100, 103)), radius=5 * scale, outline="#153b2b", width=7 * scale)
draw.rounded_rectangle(points((24, 27, 104, 46)), radius=4 * scale, fill="#153b2b")
draw.line(points((64, 61, 64, 86)), fill="#153b2b", width=7 * scale)
draw.line([points(p) for p in ((53, 77), (64, 88), (75, 77))], fill="#153b2b", width=7 * scale, joint="curve")
for size in (16, 32, 48, 128):
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(folder / f"icon-{size}.png")
print("Rendered 4 toolbar icons.")
