#!/usr/bin/env python3
"""Regenerate the Android/Play Store image assets from assets/images/tcb-logo.png.

    cd mobile && pip install Pillow && python3 scripts/make-play-assets.py

Writes three files into assets/images/:

  android-adaptive-foreground.png  1024x1024  launcher icon foreground layer
  play-store-icon.png               512x512   Play Console "App icon"
  play-feature-graphic.png         1024x500   Play Console "Feature graphic"

The source logo is opaque artwork drawn on white, so step one is to recover a real alpha
channel from it; everything else is scaling and composition.
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter

SRC = "assets/images/tcb-logo.png"
OUT = "assets/images"
FONTS = "/mnt/skills/examples/canvas-design/canvas-fonts"  # WorkSans; any grotesque works
RED = (228, 0, 43)  # TCB brand red, matches theme.tsx
INK = (10, 10, 11)

# Android masks the outer third of the adaptive-icon foreground into whatever shape the
# launcher uses, so artwork must stay inside the centre 72/108 of the canvas. The previous
# icon pointed `foregroundImage` at the full-bleed logo and lost the shield tips and the
# spider's legs on every circular launcher.
SAFE_ZONE = 72 / 108


def logo_transparent() -> Image.Image:
    """Undo the white compositing baked into the source PNG, cropped to the artwork."""
    im = Image.open(SRC).convert("RGB")
    px = im.load()
    out = Image.new("RGBA", im.size)
    op = out.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b = px[x, y]
            a = 255 - min(r, g, b)  # pure white -> transparent, ink -> opaque
            if a == 0:
                op[x, y] = (0, 0, 0, 0)
                continue
            f = 255.0 / a  # un-premultiply from a white backdrop
            op[x, y] = (
                max(0, min(255, round((r - 255 + a) * f))),
                max(0, min(255, round((g - 255 + a) * f))),
                max(0, min(255, round((b - 255 + a) * f))),
                a,
            )
    return out.crop(out.getchannel("A").getbbox())


def fit(logo: Image.Image, canvas_px: int, frac: float) -> Image.Image:
    """Scale so the longest side is `frac` of `canvas_px`."""
    w, h = logo.size
    s = (canvas_px * frac) / max(w, h)
    return logo.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


def paste_centered(canvas: Image.Image, logo: Image.Image) -> None:
    x = (canvas.size[0] - logo.size[0]) // 2
    y = (canvas.size[1] - logo.size[1]) // 2
    canvas.alpha_composite(logo, (x, y))


def adaptive_foreground(logo: Image.Image) -> None:
    # 0.60 of the canvas keeps the artwork comfortably inside SAFE_ZONE (0.667) with a
    # little breathing room, so it survives circle, squircle and rounded-square masks.
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    paste_centered(canvas, fit(logo, 1024, 0.60))
    canvas.save(f"{OUT}/android-adaptive-foreground.png")


def play_icon(logo: Image.Image) -> None:
    # Play requires a 512x512 32-bit PNG; it applies its own rounding, so leave a margin.
    canvas = Image.new("RGBA", (512, 512), (255, 255, 255, 255))
    paste_centered(canvas, fit(logo, 512, 0.78))
    canvas.save(f"{OUT}/play-store-icon.png")


def feature_graphic(logo: Image.Image) -> None:
    # 1024x500, 24-bit, no alpha. Play crops the edges in some placements, so the tile and
    # the type stay well inside the frame.
    w, h = 1024, 500
    img = Image.new("RGB", (w, h), INK)
    d = ImageDraw.Draw(img)
    for y in range(h):
        v = round(9 + 17 * (1 - y / (h - 1)))
        d.line([(0, y), (w, y)], fill=(v, v, v + 1))

    glow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(glow).ellipse([70, 110, 400, 440], fill=90)
    img = Image.composite(Image.new("RGB", (w, h), RED), img, glow.filter(ImageFilter.GaussianBlur(70)))

    # The logo is black-on-white artwork, so it needs a light tile to read against the
    # dark field -- dropping it straight onto the background loses the shield entirely.
    size, tx, ty = 300, 96, 100
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size * 4 - 1, size * 4 - 1], radius=round(size * 4 / 4.6), fill=255
    )
    tile.paste(Image.new("RGBA", (size, size), (255, 255, 255, 255)), (0, 0), mask.resize((size, size), Image.LANCZOS))
    paste_centered(tile, fit(logo, size, 0.76))
    img.paste(tile, (tx, ty), tile)

    d = ImageDraw.Draw(img)
    text_x = tx + size + 76
    d.text((text_x, 184), "TCB Phone", font=ImageFont.truetype(f"{FONTS}/WorkSans-Bold.ttf", 88), fill=(255, 255, 255))
    d.text((text_x, 288), "Calls, SMS & Messenger", font=ImageFont.truetype(f"{FONTS}/WorkSans-Regular.ttf", 34), fill=(206, 206, 214))
    d.line([(text_x + 3, 350), (text_x + 88, 350)], fill=RED, width=6)
    img.save(f"{OUT}/play-feature-graphic.png")


if __name__ == "__main__":
    logo = logo_transparent()
    adaptive_foreground(logo)
    play_icon(logo)
    feature_graphic(logo)
    print("wrote android-adaptive-foreground.png, play-store-icon.png, play-feature-graphic.png")
