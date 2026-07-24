"""
Generate Personal Vault icons: orange V with black outline/shadow.
Produces all sizes needed by the Chrome extension and Tauri desktop app.
"""

import struct
import zlib
import io
import os
from PIL import Image, ImageDraw

ORANGE = (235, 120, 30, 255)      # main fill
DARK_ORANGE = (180, 80, 10, 255)  # inner shading
BLACK = (20, 20, 20, 255)         # outline / shadow stroke
BG = (255, 255, 255, 0)           # transparent background


def draw_v_icon(size: int) -> Image.Image:
    """
    Draw the V icon at the given square pixel size.
    The V has:
      - a rounded black outline (stroke)
      - orange fill with a subtle dark-orange inner gradient line
      - a small black shield-like base curve for visual grounding
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    s = size
    pad = s * 0.08          # outer padding
    stroke = max(1, s * 0.07)  # outline thickness

    # V geometry: two arms meeting at the bottom center
    cx = s / 2
    top_y = pad
    bot_y = s - pad
    left_x = pad
    right_x = s - pad
    mid_x = cx
    # The notch top (where the V opens) is split
    inner_top_left_x = left_x + (right_x - left_x) * 0.28
    inner_top_right_x = left_x + (right_x - left_x) * 0.72
    inner_top_y = top_y + (bot_y - top_y) * 0.08
    inner_bot_y = bot_y - (bot_y - top_y) * 0.08

    # Outer V polygon (for the stroke layer — slightly larger)
    outer = [
        (left_x,            top_y),
        (inner_top_left_x,  top_y),
        (mid_x,             inner_bot_y),
        (inner_top_right_x, top_y),
        (right_x,           top_y),
        (mid_x + stroke,    bot_y),
        (mid_x,             bot_y),
        (mid_x - stroke,    bot_y),
    ]

    # Draw black outline (slightly expanded polygon)
    def expand_poly(pts, amount):
        """Naive inset/outset by shifting each point outward from centroid."""
        cx_ = sum(p[0] for p in pts) / len(pts)
        cy_ = sum(p[1] for p in pts) / len(pts)
        result = []
        for x, y in pts:
            dx = x - cx_
            dy = y - cy_
            length = (dx**2 + dy**2) ** 0.5
            if length == 0:
                result.append((x, y))
            else:
                result.append((x + dx / length * amount, y + dy / length * amount))
        return result

    black_poly = expand_poly(outer, stroke * 0.6)
    d.polygon(black_poly, fill=BLACK)

    # Inner fill polygon (the orange V body)
    inner_left_x  = left_x  + stroke
    inner_right_x = right_x - stroke
    inner_notch_left  = inner_top_left_x  + stroke * 0.4
    inner_notch_right = inner_top_right_x - stroke * 0.4
    inner_top_y2 = top_y + stroke * 0.5
    inner_bot_y2 = bot_y - stroke * 0.3

    fill_poly = [
        (inner_left_x,       inner_top_y2),
        (inner_notch_left,   inner_top_y2),
        (mid_x,              inner_bot_y2),
        (inner_notch_right,  inner_top_y2),
        (inner_right_x,      inner_top_y2),
        (mid_x + stroke * 0.3, inner_bot_y2),
        (mid_x,              inner_bot_y2),
        (mid_x - stroke * 0.3, inner_bot_y2),
    ]
    d.polygon(fill_poly, fill=ORANGE)

    # Inner dark shading line down the right arm of V (gives depth)
    shade_width = max(1, stroke * 0.4)
    shade_poly = [
        (inner_notch_right - shade_width, inner_top_y2 + stroke * 0.5),
        (inner_notch_right,               inner_top_y2 + stroke * 0.5),
        (mid_x + shade_width,             inner_bot_y2 - stroke * 0.5),
        (mid_x,                           inner_bot_y2 - stroke * 0.5),
    ]
    d.polygon(shade_poly, fill=DARK_ORANGE)

    # Tiny highlight line on left arm
    hi_width = max(1, stroke * 0.25)
    hi_color = (255, 200, 100, 180)
    hi_poly = [
        (inner_left_x + hi_width,           inner_top_y2 + stroke * 0.5),
        (inner_left_x + hi_width * 2.5,     inner_top_y2 + stroke * 0.5),
        (mid_x - hi_width,                   inner_bot_y2 - stroke * 0.5),
        (mid_x - hi_width * 2,               inner_bot_y2 - stroke * 0.5),
    ]
    d.polygon(hi_poly, fill=hi_color)

    return img


def make_ico(images_by_size: dict[int, Image.Image]) -> bytes:
    """Build a .ico file from a dict of {size: Image}."""
    sizes = sorted(images_by_size.keys())
    # ICO supports up to 256; sizes > 48 are embedded as PNG inside ICO
    entries = []
    image_data = []
    for sz in sizes:
        img = images_by_size[sz].convert("RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        image_data.append(data)
        entries.append((sz, data))

    # Header: ICONDIR
    num = len(entries)
    header = struct.pack("<HHH", 0, 1, num)  # reserved, type=1 (ICO), count

    # Each ICONDIRENTRY is 16 bytes
    offset = 6 + num * 16
    dir_entries = b""
    for (sz, data) in entries:
        w = 0 if sz == 256 else sz
        h = 0 if sz == 256 else sz
        dir_entries += struct.pack(
            "<BBBBHHII",
            w, h,    # width, height
            0,       # color count (0 = more than 256)
            0,       # reserved
            1,       # planes
            32,      # bit count
            len(data),
            offset,
        )
        offset += len(data)

    return header + dir_entries + b"".join(d for _, d in entries)


def make_icns(images_by_size: dict[int, Image.Image]) -> bytes:
    """
    Build a minimal .icns file.
    Only includes the types Chrome / macOS care about.
    """
    # OSType → (size, is_retina)
    type_map = {
        b"icp4": 16,
        b"icp5": 32,
        b"icp6": 64,
        b"ic07": 128,
        b"ic08": 256,
    }

    chunks = b""
    for ostype, sz in type_map.items():
        img = images_by_size.get(sz)
        if img is None:
            continue
        buf = io.BytesIO()
        img.convert("RGBA").save(buf, format="PNG")
        data = buf.getvalue()
        chunk_size = 8 + len(data)
        chunks += ostype + struct.pack(">I", chunk_size) + data

    total = 8 + len(chunks)
    return b"icns" + struct.pack(">I", total) + chunks


def main():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    ext_icons_dir = os.path.join(repo_root, "extension", "dist", "icons")
    tauri_icons_dir = os.path.join(repo_root, "desktop", "src-tauri", "icons")

    os.makedirs(ext_icons_dir, exist_ok=True)
    # tauri icons dir already exists

    # All pixel sizes we need across both targets
    all_sizes = [16, 32, 48, 64, 128, 256]
    rendered: dict[int, Image.Image] = {}
    for sz in all_sizes:
        rendered[sz] = draw_v_icon(sz)

    # --- Chrome extension ---
    for sz in [16, 48, 128]:
        path = os.path.join(ext_icons_dir, f"icon{sz}.png")
        rendered[sz].save(path, format="PNG")
        print(f"  wrote {path}")

    # --- Tauri desktop ---
    rendered[32].save(os.path.join(tauri_icons_dir, "32x32.png"), format="PNG")
    print(f"  wrote {tauri_icons_dir}/32x32.png")

    rendered[128].save(os.path.join(tauri_icons_dir, "128x128.png"), format="PNG")
    print(f"  wrote {tauri_icons_dir}/128x128.png")

    # 128x128@2x is 256px rendered at 128 logical → save the 256px render
    rendered[256].save(os.path.join(tauri_icons_dir, "128x128@2x.png"), format="PNG")
    print(f"  wrote {tauri_icons_dir}/128x128@2x.png")

    ico_path = os.path.join(tauri_icons_dir, "icon.ico")
    with open(ico_path, "wb") as f:
        f.write(make_ico({16: rendered[16], 32: rendered[32], 48: rendered[48], 256: rendered[256]}))
    print(f"  wrote {ico_path}")

    icns_path = os.path.join(tauri_icons_dir, "icon.icns")
    with open(icns_path, "wb") as f:
        f.write(make_icns(rendered))
    print(f"  wrote {icns_path}")

    print("Done.")


if __name__ == "__main__":
    main()
