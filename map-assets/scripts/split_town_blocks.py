from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "town_blocks" / "source" / "town_blocks_atlas.png"
SPRITES = ROOT / "assets" / "town_blocks" / "sprites"
TILES = ROOT / "assets" / "town_blocks" / "tiles"
SEAMLESS_TILES = ROOT / "assets" / "town_blocks" / "seamless_tiles"
DOCS = ROOT / "assets" / "town_blocks" / "docs"
META = ROOT / "assets" / "town_blocks" / "atlas.json"

TILE_SIZE = 256
COLUMNS = 6

ASSETS = [
    ("house_red", "building", "small cozy house with red roof"),
    ("house_blue", "building", "larger house with blue roof"),
    ("shop_food", "building", "food shop"),
    ("shop_clothing", "building", "clothing shop"),
    ("shop_interior", "building", "interior and furniture shop"),
    ("shop_pawn", "building", "pawn or secondhand shop"),
    ("restaurant", "building", "small restaurant"),
    ("builder_shop", "building", "construction and carpenter shop"),
    ("farm_coop", "building", "agricultural cooperative shop"),
    ("bank", "building", "small bank"),
    ("town_hall", "building", "town hall or community building"),
    ("agent_hut", "building", "tiny agent hut or workshop"),
    ("road_straight", "road", "straight cobblestone road tile"),
    ("road_corner", "road", "curved road corner tile"),
    ("road_t", "road", "road T-junction tile"),
    ("road_cross", "road", "road crossing tile"),
    ("dirt_path", "terrain", "dirt path tile"),
    ("grass_field", "terrain", "grassy field tile with flowers"),
    ("wild_meadow", "terrain", "wild meadow tile"),
    ("farm_plot", "terrain", "farm plot tile"),
    ("forest_edge", "obstacle", "forest edge block"),
    ("dense_forest", "obstacle", "dense forest block"),
    ("pond_edge", "water", "pond or water edge tile"),
    ("plaza_stone", "terrain", "plaza stone tile"),
]


BACKGROUND_KINDS = {"road", "terrain", "water", "obstacle"}


def color_shift(color: tuple[int, int, int], amount: int) -> tuple[int, int, int]:
    return tuple(max(0, min(255, channel + amount)) for channel in color)


def draw_scattered_detail(draw: ImageDraw.ImageDraw, rng: random.Random, kind: str) -> None:
    if kind in {"grass_field", "wild_meadow", "forest_edge", "dense_forest"}:
        flower_colors = [(245, 231, 92), (255, 174, 105), (245, 246, 235), (225, 123, 170)]
        count = 34 if kind == "grass_field" else 22
        if kind in {"forest_edge", "dense_forest"}:
            count = 8
        for _ in range(count):
            x = rng.randrange(8, TILE_SIZE - 8)
            y = rng.randrange(8, TILE_SIZE - 8)
            color = rng.choice(flower_colors)
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=color)
        for _ in range(80):
            x = rng.randrange(TILE_SIZE)
            y = rng.randrange(TILE_SIZE)
            draw.line((x, y, x + rng.randrange(-2, 3), y - rng.randrange(2, 7)), fill=(75, 136, 42), width=1)


def draw_stone_grid(draw: ImageDraw.ImageDraw, base: tuple[int, int, int], mortar: tuple[int, int, int]) -> None:
    draw.rectangle((0, 0, TILE_SIZE, TILE_SIZE), fill=base)
    cell_w, cell_h = 32, 24
    for y in range(-cell_h, TILE_SIZE + cell_h, cell_h):
        offset = 0 if (y // cell_h) % 2 == 0 else cell_w // 2
        for x in range(-cell_w, TILE_SIZE + cell_w, cell_w):
            x0 = x + offset
            draw.rounded_rectangle((x0 + 2, y + 2, x0 + cell_w - 2, y + cell_h - 2), radius=4, fill=color_shift(base, 10), outline=mortar, width=2)


def make_seamless_tile(asset_id: str, kind: str, fallback: Image.Image) -> Image.Image:
    rng = random.Random(asset_id)
    tile = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (118, 160, 54, 255))
    draw = ImageDraw.Draw(tile, "RGBA")

    if asset_id in {"grass_field", "wild_meadow"}:
        base = (111, 164, 54) if asset_id == "grass_field" else (91, 151, 55)
        draw.rectangle((0, 0, TILE_SIZE, TILE_SIZE), fill=base)
        for y in range(0, TILE_SIZE, 16):
            draw.line((0, y, TILE_SIZE, y), fill=(*color_shift(base, 10), 70), width=2)
        draw_scattered_detail(draw, rng, asset_id)
    elif asset_id == "farm_plot":
        draw.rectangle((0, 0, TILE_SIZE, TILE_SIZE), fill=(111, 72, 38))
        for y in range(16, TILE_SIZE, 32):
            draw.rounded_rectangle((0, y - 8, TILE_SIZE, y + 8), radius=8, fill=(94, 59, 31))
            for x in range(16, TILE_SIZE, 32):
                draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=(80, 151, 52))
                draw.ellipse((x - 3, y - 13, x + 9, y - 1), fill=(98, 178, 61))
    elif asset_id == "dirt_path":
        draw.rectangle((0, 0, TILE_SIZE, TILE_SIZE), fill=(196, 137, 75))
        for _ in range(130):
            x = rng.randrange(TILE_SIZE)
            y = rng.randrange(TILE_SIZE)
            r = rng.randrange(1, 4)
            shade = rng.choice([(171, 111, 61), (219, 164, 95), (139, 100, 71)])
            draw.ellipse((x - r, y - r, x + r, y + r), fill=(*shade, 135))
    elif asset_id.startswith("road") or asset_id == "plaza_stone":
        if asset_id == "plaza_stone":
            draw.rectangle((0, 0, TILE_SIZE, TILE_SIZE), fill=(188, 160, 125))
            for radius in range(24, 170, 28):
                draw.ellipse((128 - radius, 128 - radius, 128 + radius, 128 + radius), outline=(132, 108, 86), width=3)
            for angle in range(0, 360, 30):
                end_x = 128 + int(190 * math.cos(math.radians(angle)))
                end_y = 128 + int(190 * math.sin(math.radians(angle)))
                draw.line((128, 128, end_x, end_y), fill=(132, 108, 86), width=2)
        else:
            draw_stone_grid(draw, (154, 148, 132), (104, 100, 90))
    elif asset_id in {"forest_edge", "dense_forest"}:
        draw.rectangle((0, 0, TILE_SIZE, TILE_SIZE), fill=(53, 113, 45))
        count = 22 if asset_id == "dense_forest" else 14
        for _ in range(count):
            x = rng.randrange(-12, TILE_SIZE + 12)
            y = rng.randrange(-12, TILE_SIZE + 12)
            r = rng.randrange(22, 42)
            color = rng.choice([(58, 128, 52), (76, 151, 55), (45, 104, 67), (95, 166, 55)])
            draw.ellipse((x - r, y - r, x + r, y + r), fill=color)
            draw.ellipse((x - r + 8, y - r + 7, x + r - 10, y + r - 12), fill=(*color_shift(color, 18), 95))
        draw_scattered_detail(draw, rng, asset_id)
    elif asset_id == "pond_edge":
        draw.rectangle((0, 0, TILE_SIZE, TILE_SIZE), fill=(54, 153, 184))
        for y in range(18, TILE_SIZE, 28):
            draw.arc((-20, y - 16, 120, y + 24), 10, 170, fill=(104, 203, 222), width=3)
            draw.arc((120, y - 18, 280, y + 26), 190, 350, fill=(38, 120, 164), width=2)
        for _ in range(18):
            x = rng.randrange(TILE_SIZE)
            y = rng.randrange(TILE_SIZE)
            draw.ellipse((x - 8, y - 3, x + 8, y + 3), fill=(77, 178, 101, 160))
    else:
        return filled_tile(fallback)

    tile.putalpha(255)
    return tile


def find_components(atlas: Image.Image) -> list[tuple[int, int, int, int]]:
    alpha = atlas.getchannel("A")
    width, height = atlas.size
    seen = bytearray(width * height)
    components: list[tuple[int, tuple[int, int, int, int]]] = []

    for start_y in range(height):
        for start_x in range(width):
            start_index = start_y * width + start_x
            if seen[start_index] or alpha.getpixel((start_x, start_y)) <= 10:
                continue

            stack = [(start_x, start_y)]
            seen[start_index] = 1
            xs: list[int] = []
            ys: list[int] = []

            while stack:
                x, y = stack.pop()
                xs.append(x)
                ys.append(y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < width and 0 <= ny < height:
                        index = ny * width + nx
                        if not seen[index] and alpha.getpixel((nx, ny)) > 10:
                            seen[index] = 1
                            stack.append((nx, ny))

            if len(xs) > 100:
                components.append((len(xs), (min(xs), min(ys), max(xs) + 1, max(ys) + 1)))

    boxes = [box for _, box in components]
    boxes.sort(key=lambda box: ((box[1] + box[3]) / 2, (box[0] + box[2]) / 2))
    rows = [boxes[i : i + COLUMNS] for i in range(0, len(boxes), COLUMNS)]
    if len(rows) != 4 or any(len(row) != COLUMNS for row in rows):
        raise ValueError(f"Expected 24 large components in 4 rows, got {len(boxes)}")
    ordered: list[tuple[int, int, int, int]] = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda box: (box[0] + box[2]) / 2))
    return ordered


def padded_box(box: tuple[int, int, int, int], image_size: tuple[int, int], padding: int = 4) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = box
    width, height = image_size
    return (max(0, x0 - padding), max(0, y0 - padding), min(width, x1 + padding), min(height, y1 + padding))


def placed_sprite(atlas: Image.Image, box: tuple[int, int, int, int], kind: str) -> tuple[Image.Image, dict[str, int]]:
    crop = atlas.crop(padded_box(box, atlas.size))
    bbox = crop.getchannel("A").getbbox()
    if bbox is None:
        return Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0)), {"x": 0, "y": 0, "w": 0, "h": 0}
    crop = crop.crop(bbox)
    if crop.width > TILE_SIZE or crop.height > TILE_SIZE:
        scale = min(TILE_SIZE / crop.width, TILE_SIZE / crop.height)
        crop = crop.resize((int(crop.width * scale), int(crop.height * scale)), Image.Resampling.LANCZOS)

    sprite = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
    x = (TILE_SIZE - crop.width) // 2
    if kind in {"building", "obstacle", "water"}:
        y = TILE_SIZE - crop.height - 18
    else:
        y = (TILE_SIZE - crop.height) // 2
    y = max(0, min(TILE_SIZE - crop.height, y))
    sprite.alpha_composite(crop, (x, y))
    return sprite, {"x": x, "y": y, "w": crop.width, "h": crop.height}


def filled_tile(sprite: Image.Image) -> Image.Image:
    """Place a sprite on an opaque representative color so background tiles meet cleanly."""
    source = sprite.convert("RGBA")
    bbox = source.getchannel("A").getbbox()
    if bbox is not None:
        source = source.crop(bbox).resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)
    colors: dict[tuple[int, int, int], int] = {}
    raw = source.tobytes()
    for index in range(0, len(raw), 4):
        r, g, b, a = raw[index], raw[index + 1], raw[index + 2], raw[index + 3]
        if a > 230 and r + g + b > 80:
            key = (round(r / 16) * 16, round(g / 16) * 16, round(b / 16) * 16)
            colors[key] = colors.get(key, 0) + 1
    fill = max(colors.items(), key=lambda item: item[1])[0] if colors else (128, 160, 104)
    out = Image.new("RGBA", source.size, (*fill, 255))
    out.alpha_composite(source)
    return out


def collision_for(kind: str, content: dict[str, int]) -> dict[str, object]:
    if kind not in {"building", "obstacle", "water"}:
        return {"type": "none", "solid": False}
    if kind == "building":
        rect = {
            "x": content["x"] + round(content["w"] * 0.12),
            "y": content["y"] + round(content["h"] * 0.66),
            "w": round(content["w"] * 0.76),
            "h": max(24, round(content["h"] * 0.22)),
        }
    elif kind == "water":
        rect = {
            "x": content["x"] + round(content["w"] * 0.05),
            "y": content["y"] + round(content["h"] * 0.18),
            "w": round(content["w"] * 0.90),
            "h": round(content["h"] * 0.62),
        }
    else:
        rect = {
            "x": content["x"] + round(content["w"] * 0.06),
            "y": content["y"] + round(content["h"] * 0.18),
            "w": round(content["w"] * 0.88),
            "h": round(content["h"] * 0.70),
        }
    return {"type": "rect", "solid": True, **rect}


def main() -> None:
    SPRITES.mkdir(parents=True, exist_ok=True)
    TILES.mkdir(parents=True, exist_ok=True)
    SEAMLESS_TILES.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)

    atlas = Image.open(SOURCE).convert("RGBA")
    component_boxes = find_components(atlas)
    manifest: dict[str, object] = {
        "tileSize": TILE_SIZE,
        "columns": COLUMNS,
        "camera": "3/4 top-down orthographic",
        "anchor": {"x": 128, "y": 224, "meaning": "bottom-center gameplay anchor"},
        "collisionGuidance": "Use the supplied simple rects for buildings, forest, and water. Roads and terrain are passable.",
        "assets": [],
    }

    preview = Image.new("RGBA", (COLUMNS * TILE_SIZE, 4 * TILE_SIZE), (255, 255, 255, 255))
    overlay = Image.new("RGBA", (COLUMNS * TILE_SIZE, 4 * TILE_SIZE), (255, 255, 255, 255))
    seamless_preview = Image.new("RGBA", (COLUMNS * TILE_SIZE, 4 * TILE_SIZE), (255, 255, 255, 255))

    for index, (name, kind, description) in enumerate(ASSETS):
        col = index % COLUMNS
        row = index // COLUMNS
        source_box = component_boxes[index]
        sprite, content_box = placed_sprite(atlas, source_box, kind)
        collision = collision_for(kind, content_box)
        sprite_path = SPRITES / f"{name}.png"
        sprite.save(sprite_path)
        tile_path = TILES / f"{name}.png"
        filled_tile(sprite).save(tile_path)
        seamless_path = SEAMLESS_TILES / f"{name}.png"
        seamless = make_seamless_tile(name, kind, sprite)
        seamless.save(seamless_path)

        preview.alpha_composite(sprite, (col * TILE_SIZE, row * TILE_SIZE))
        seamless_preview.alpha_composite(seamless, (col * TILE_SIZE, row * TILE_SIZE))
        overlay.alpha_composite(sprite, (col * TILE_SIZE, row * TILE_SIZE))
        if collision["type"] == "rect":
            draw = ImageDraw.Draw(overlay, "RGBA")
            x0 = col * TILE_SIZE + int(collision["x"])
            y0 = row * TILE_SIZE + int(collision["y"])
            x1 = x0 + int(collision["w"])
            y1 = y0 + int(collision["h"])
            draw.rectangle((x0, y0, x1, y1), outline=(255, 40, 40, 255), width=4, fill=(255, 40, 40, 42))

        manifest["assets"].append(
            {
                "id": name,
                "file": f"sprites/{name}.png",
                "tileFile": f"tiles/{name}.png",
                "seamlessTileFile": f"seamless_tiles/{name}.png",
                "kind": kind,
                "description": description,
                "atlasIndex": index,
                "sourceBounds": {"x": source_box[0], "y": source_box[1], "w": source_box[2] - source_box[0], "h": source_box[3] - source_box[1]},
                "spriteContentBounds": content_box,
                "recommendedLayer": "background" if kind in BACKGROUND_KINDS else "object",
                "collision": collision,
            }
        )

    preview.save(DOCS / "town_blocks_preview.png")
    seamless_preview.save(DOCS / "town_blocks_seamless_tiles_preview.png")
    overlay.save(DOCS / "town_blocks_collision_overlay.png")
    META.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
