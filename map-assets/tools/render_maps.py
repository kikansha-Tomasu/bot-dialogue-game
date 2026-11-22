from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
MAPS_JSON = ROOT / "assets" / "maps" / "town_maps.json"
ATLAS_JSON = ROOT / "assets" / "town_blocks" / "atlas.json"
OUT_DIR = ROOT / "docs" / "map_previews"


def load_sprite(asset_root: Path, path_value: str, size: int) -> Image.Image:
    path = asset_root / path_value
    return Image.open(path).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)


def draw_map(
    map_data: dict[str, object],
    sprites: dict[str, Image.Image],
    tiles: dict[str, Image.Image],
    collisions: dict[str, dict[str, object]],
    tile_size: int,
    out_path: Path,
) -> None:
    width = int(map_data["width"])
    height = int(map_data["height"])
    margin = 40
    title_h = 64
    image = Image.new("RGBA", (width * tile_size + margin * 2, height * tile_size + title_h + margin), (245, 248, 239, 255))
    draw = ImageDraw.Draw(image, "RGBA")

    font = ImageFont.load_default()
    draw.text((margin, 22), f"{map_data['name']}  ({width}x{height})", fill=(51, 62, 55, 255), font=font)

    ox = margin
    oy = title_h
    legend = map_data["legend"]
    terrain = map_data["terrain"]

    for y, row in enumerate(terrain):
        for x, key in enumerate(row):
            asset_id = legend[key]
            image.alpha_composite(tiles[asset_id], (ox + x * tile_size, oy + y * tile_size))

    objects = sorted(map_data["objects"], key=lambda item: (int(item["y"]), int(item["x"])))
    for item in objects:
        x = int(item["x"])
        y = int(item["y"])
        asset_id = str(item["asset"])
        image.alpha_composite(sprites[asset_id], (ox + x * tile_size, oy + y * tile_size))
        collision = collisions[asset_id]
        if collision.get("type") == "rect" and collision.get("solid"):
            scale = tile_size / 256
            cx = ox + x * tile_size + int(float(collision["x"]) * scale)
            cy = oy + y * tile_size + int(float(collision["y"]) * scale)
            cw = int(float(collision["w"]) * scale)
            ch = int(float(collision["h"]) * scale)
            draw.rectangle((cx, cy, cx + cw, cy + ch), fill=(245, 51, 58, 34), outline=(245, 51, 58, 210), width=2)

    spawn = map_data["spawn"]
    sx = ox + int(spawn["x"]) * tile_size + tile_size // 2
    sy = oy + int(spawn["y"]) * tile_size + tile_size // 2
    r = max(6, tile_size // 14)
    draw.ellipse((sx - r, sy - r, sx + r, sy + r), fill=(32, 122, 255, 235), outline=(255, 255, 255, 255), width=2)

    image.convert("RGB").save(out_path)


def main() -> None:
    maps_doc = json.loads(MAPS_JSON.read_text(encoding="utf-8"))
    atlas_doc = json.loads(ATLAS_JSON.read_text(encoding="utf-8"))
    asset_root = ROOT / "assets" / "town_blocks"
    tile_size = int(maps_doc["tileSize"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    sprites = {
        str(asset["id"]): load_sprite(asset_root, str(asset["file"]), tile_size)
        for asset in atlas_doc["assets"]
    }
    tiles = {
        str(asset["id"]): load_sprite(asset_root, str(asset["seamlessTileFile"]), tile_size)
        for asset in atlas_doc["assets"]
    }
    collisions = {str(asset["id"]): asset["collision"] for asset in atlas_doc["assets"]}

    for map_data in maps_doc["maps"]:
        draw_map(map_data, sprites, tiles, collisions, tile_size, OUT_DIR / f"{map_data['id']}.png")


if __name__ == "__main__":
    main()
