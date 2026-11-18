"""Upgrade bundled LibreTV frontend theme, motion FX, and Aurora brand icons."""
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

GLOBAL_CSS = ".next/static/css/58d1eabd0a5200ce.css"
APP_LAYOUT = ".next/static/chunks/app/layout-45a4982cfa62ca6c.js"

ICON_SIZES = {
    "public/icons/icon-512.png": 512,
    "public/icons/icon-192.png": 192,
    "public/icons/icon-144.png": 144,
    "public/icons/icon-96.png": 96,
    "public/icons/icon-48.png": 48,
    "public/icons/apple-touch-icon.png": 180,
}

FAVICON_PATH = "public/favicon.ico"
PLAYER_POSTER_PATH = "public/player-poster.png"


def _replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError(
            f"Bundled LibreTV UI chunk mismatch at {before[:72]!r} (count={text.count(before)})"
        )
    return text.replace(before, after, 1)


def patch_global_css(source):
    css_fx = Path(__file__).with_name("ui-fx.css").read_text(encoding="utf-8")
    if "/* ltv-ui-fx-v1 */" in source:
        return source
    return source + "\n" + css_fx


def patch_app_layout(source):
    source = _replace_once(
        source,
        "onClick:()=>r(o)",
        "onClick:ev=>window.__ltvThemeTransition?window.__ltvThemeTransition(ev,()=>r(o)):r(o)",
    )
    js_fx = Path(__file__).with_name("ui-fx.js").read_text(encoding="utf-8")
    if "window.__ltvUiFxInstalled" in source:
        return source
    return source + "\n;" + js_fx


def _load_brand_master():
    tools_dir = Path(__file__).resolve().parent
    candidates = [
        tools_dir / "brand-icon-512.png",
        tools_dir.parent / "app" / "src" / "main" / "res" / "mipmap-xxxhdpi" / "ic_launcher.png",
    ]
    for path in candidates:
        if path.is_file():
            return Image.open(path).convert("RGBA")
    raise FileNotFoundError("Missing Aurora brand icon source")


def _rounded_icon(master, size):
    scale = 4
    hi = size * scale
    img = master.resize((hi, hi), Image.Resampling.LANCZOS)
    mask = Image.new("L", (hi, hi), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(hi * 0.22)
    draw.rounded_rectangle((0, 0, hi - 1, hi - 1), radius=radius, fill=255)
    img.putalpha(mask)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def _png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _poster_bytes(master):
    w, h = 1280, 720
    canvas = Image.new("RGBA", (w, h), (7, 11, 20, 255))

    # Subtle vertical twilight gradient
    grad = Image.new("RGBA", (1, h))
    gpx = grad.load()
    for y in range(h):
        t = y / float(h - 1)
        r = int(7 + (15 - 7) * t)
        g = int(11 + (26 - 11) * t)
        b = int(20 + (46 - 20) * t)
        gpx[0, y] = (r, g, b, 255)
    canvas.paste(grad.resize((w, h), Image.Resampling.BILINEAR), (0, 0))

    # Aurora atmospheric stage lighting (clean center so ArtPlayer spinner/icon never collides)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((80, -40, 860, 560), fill=(0, 200, 248, 38))
    gd.ellipse((460, 140, 1220, 700), fill=(99, 102, 241, 34))
    gd.ellipse((320, 260, 960, 640), fill=(244, 114, 182, 18))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=110))
    canvas = Image.alpha_composite(canvas, glow)

    # Subtle bottom-left corner brand watermark (keeps center stage clear for playback/loading spinner)
    badge_size = 56
    badge = _rounded_icon(master, badge_size)
    r, g, b, a = badge.split()
    a = a.point(lambda p: (p * 140) // 255)
    badge = Image.merge("RGBA", (r, g, b, a))
    halo = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse((16, h - 128, 136, h - 8), fill=(0, 200, 248, 36))
    halo = halo.filter(ImageFilter.GaussianBlur(radius=28))
    canvas = Image.alpha_composite(canvas, halo)
    canvas.paste(badge, (48, h - 96), badge)

    buf = io.BytesIO()
    canvas.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build_brand_assets():
    master = _load_brand_master()
    out = {}
    for key, size in ICON_SIZES.items():
        out[key] = _png_bytes(_rounded_icon(master, size))
    ico_buf = io.BytesIO()
    _rounded_icon(master, 64).save(ico_buf, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    out[FAVICON_PATH] = ico_buf.getvalue()
    out[PLAYER_POSTER_PATH] = _poster_bytes(master)
    return out


UI_FX_TEXT_PATCHES = {
    GLOBAL_CSS: patch_global_css,
    APP_LAYOUT: patch_app_layout,
}
