from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "progression_layers"
BASE_OUT = OUT / "base_tiles"
TOWN_OUT = OUT / "town"
CROP_OUT = OUT / "crops"
DOCS = OUT / "docs"
META = OUT / "progression_layers.json"
TILE = 256


def rgba(color: tuple[int, int, int], alpha: int = 255) -> tuple[int, int, int, int]:
    return (*color, alpha)


def shadow(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], alpha: int = 48) -> None:
    draw.ellipse(box, fill=(60, 42, 25, alpha))


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], fill, outline=None, width: int = 1, radius: int = 8) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def blank() -> Image.Image:
    return Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))


def save_town_asset(asset_id: str, target: list[str], stage: int, draw_fn, description: str) -> dict[str, object]:
    img = blank()
    draw = ImageDraw.Draw(img, "RGBA")
    draw_fn(draw)
    path = TOWN_OUT / f"{asset_id}.png"
    img.save(path)
    return {
        "id": asset_id,
        "file": f"town/{asset_id}.png",
        "type": "development_overlay",
        "stage": stage,
        "targetBase": target,
        "description": description,
        "collision": {"type": "none", "solid": False},
    }


def draw_foundation(draw: ImageDraw.ImageDraw) -> None:
    shadow(draw, (34, 166, 222, 226))
    rounded(draw, (44, 148, 212, 210), rgba((169, 132, 92), 230), rgba((103, 78, 55), 230), 3, 12)
    for x in range(58, 204, 28):
        draw.rectangle((x, 154, x + 12, 204), fill=rgba((184, 151, 105), 240), outline=rgba((111, 87, 59), 230))
    for x, y in [(48, 137), (202, 137), (48, 214), (202, 214)]:
        draw.line((x, y, x, y + 28), fill=rgba((126, 91, 52), 255), width=4)
        draw.polygon((x - 4, y + 4, x + 4, y + 4, x, y - 6), fill=rgba((148, 105, 62), 255))


def draw_scaffold(draw: ImageDraw.ImageDraw) -> None:
    for x in (54, 88, 168, 202):
        draw.line((x, 58, x, 218), fill=rgba((126, 89, 50), 245), width=6)
    for y in (72, 112, 152, 192):
        draw.line((42, y, 214, y), fill=rgba((155, 110, 58), 245), width=6)
    draw.line((48, 212, 210, 64), fill=rgba((111, 76, 42), 220), width=4)
    draw.line((48, 62, 210, 214), fill=rgba((111, 76, 42), 180), width=4)
    rounded(draw, (82, 176, 142, 214), rgba((232, 182, 68), 245), rgba((136, 91, 28), 230), 3, 8)
    draw.rectangle((92, 160, 100, 190), fill=rgba((96, 92, 87), 255))
    draw.rectangle((99, 154, 112, 168), fill=rgba((96, 92, 87), 255))


def draw_paved_border(draw: ImageDraw.ImageDraw) -> None:
    for x in range(0, TILE, 32):
        rounded(draw, (x + 2, 4, x + 30, 24), rgba((184, 174, 153), 238), rgba((119, 113, 102), 220), 2, 5)
        rounded(draw, (x + 2, 232, x + 30, 252), rgba((184, 174, 153), 238), rgba((119, 113, 102), 220), 2, 5)
    for y in range(32, TILE - 32, 32):
        rounded(draw, (4, y + 2, 24, y + 30), rgba((184, 174, 153), 238), rgba((119, 113, 102), 220), 2, 5)
        rounded(draw, (232, y + 2, 252, y + 30), rgba((184, 174, 153), 238), rgba((119, 113, 102), 220), 2, 5)


def draw_lamps(draw: ImageDraw.ImageDraw) -> None:
    for x, y in [(46, 76), (210, 76), (46, 204), (210, 204)]:
        shadow(draw, (x - 11, y + 25, x + 11, y + 37), 36)
        draw.line((x, y, x, y + 42), fill=rgba((69, 71, 72), 255), width=5)
        draw.ellipse((x - 12, y - 12, x + 12, y + 12), fill=rgba((255, 218, 106), 235), outline=rgba((96, 76, 42), 250), width=2)
        draw.ellipse((x - 22, y - 22, x + 22, y + 22), fill=rgba((255, 226, 124), 45))


def draw_planters(draw: ImageDraw.ImageDraw) -> None:
    for x, y in [(40, 42), (172, 42), (40, 180), (172, 180)]:
        rounded(draw, (x, y + 24, x + 48, y + 46), rgba((154, 87, 42), 255), rgba((91, 57, 34), 230), 2, 6)
        for ox in (9, 22, 35):
            draw.ellipse((x + ox - 9, y + 7, x + ox + 9, y + 27), fill=rgba((70, 151, 56), 255))
            draw.ellipse((x + ox - 4, y + 8, x + ox + 4, y + 16), fill=rgba((246, 185, 88), 255))


def draw_market_stalls(draw: ImageDraw.ImageDraw) -> None:
    for x, color in [(38, (224, 87, 73)), (138, (78, 150, 224))]:
        shadow(draw, (x + 8, 142, x + 86, 184), 35)
        rounded(draw, (x + 14, 116, x + 86, 170), rgba((177, 126, 67), 255), rgba((93, 62, 34), 230), 2, 8)
        for i in range(5):
            stripe = color if i % 2 == 0 else (250, 239, 203)
            draw.polygon((x + 4 + i * 18, 94, x + 24 + i * 18, 94, x + 32 + i * 18, 122, x - 2 + i * 18, 122), fill=rgba(stripe, 255))
        for i in range(4):
            draw.ellipse((x + 26 + i * 12, 140, x + 38 + i * 12, 152), fill=rgba((230, 96, 48), 255))


def draw_fountain(draw: ImageDraw.ImageDraw) -> None:
    shadow(draw, (48, 170, 208, 230), 45)
    draw.ellipse((52, 112, 204, 214), fill=rgba((171, 158, 138), 255), outline=rgba((111, 101, 89), 255), width=4)
    draw.ellipse((70, 126, 186, 198), fill=rgba((61, 159, 202), 245), outline=rgba((46, 112, 149), 245), width=3)
    draw.ellipse((100, 96, 156, 136), fill=rgba((178, 166, 145), 255), outline=rgba((111, 101, 89), 255), width=3)
    for x in (112, 128, 144):
        draw.arc((x - 24, 60, x + 24, 130), 205, 335, fill=rgba((123, 214, 235), 210), width=4)


def draw_benches(draw: ImageDraw.ImageDraw) -> None:
    for x, y in [(40, 70), (160, 172)]:
        shadow(draw, (x, y + 34, x + 72, y + 52), 34)
        for oy in (0, 11, 22):
            rounded(draw, (x, y + oy, x + 72, y + oy + 7), rgba((150, 92, 48), 255), rgba((92, 60, 34), 210), 1, 3)
        for lx in (x + 12, x + 56):
            draw.line((lx, y + 5, lx - 10, y + 42), fill=rgba((69, 69, 68), 255), width=4)


def draw_lanterns(draw: ImageDraw.ImageDraw) -> None:
    draw.line((28, 54, 228, 34), fill=rgba((83, 64, 42), 220), width=3)
    draw.line((28, 192, 228, 212), fill=rgba((83, 64, 42), 220), width=3)
    for x, y in [(54, 52), (102, 47), (150, 42), (198, 38), (54, 195), (102, 199), (150, 204), (198, 209)]:
        draw.line((x, y, x, y + 12), fill=rgba((83, 64, 42), 220), width=2)
        draw.ellipse((x - 10, y + 10, x + 10, y + 32), fill=rgba((238, 76, 67), 245), outline=rgba((123, 45, 40), 220), width=2)
        draw.ellipse((x - 18, y + 6, x + 18, y + 36), fill=rgba((255, 199, 89), 40))


def draw_signposts(draw: ImageDraw.ImageDraw) -> None:
    for x, y, text_color in [(62, 88, (58, 116, 69)), (166, 156, (72, 98, 156))]:
        shadow(draw, (x - 24, y + 58, x + 44, y + 76), 34)
        draw.line((x, y + 26, x, y + 78), fill=rgba((111, 76, 43), 255), width=6)
        rounded(draw, (x - 36, y, x + 48, y + 34), rgba((232, 194, 111), 255), rgba((118, 82, 44), 230), 3, 8)
        draw.ellipse((x - 18, y + 8, x - 6, y + 20), fill=rgba(text_color, 255))
        draw.rectangle((x, y + 11, x + 28, y + 18), fill=rgba(text_color, 230))


def draw_irrigation(draw: ImageDraw.ImageDraw) -> None:
    for x in range(24, TILE, 52):
        rounded(draw, (x, 26, x + 16, TILE - 26), rgba((56, 152, 190), 205), rgba((39, 105, 143), 230), 2, 8)
    for y in (70, 132, 194):
        rounded(draw, (18, y, TILE - 18, y + 12), rgba((56, 152, 190), 185), rgba((39, 105, 143), 210), 2, 6)


def draw_bridge(draw: ImageDraw.ImageDraw) -> None:
    shadow(draw, (28, 150, 228, 212), 45)
    for y in range(118, 188, 18):
        rounded(draw, (34, y, 222, y + 12), rgba((154, 93, 49), 255), rgba((91, 57, 33), 230), 2, 5)
    for x in range(42, 220, 28):
        draw.line((x, 110, x - 8, 198), fill=rgba((96, 60, 36), 255), width=5)


def draw_solar(draw: ImageDraw.ImageDraw) -> None:
    for x, y in [(52, 72), (132, 78), (84, 142)]:
        rounded(draw, (x, y, x + 72, y + 42), rgba((38, 71, 105), 235), rgba((16, 36, 58), 230), 2, 6)
        for gx in range(x + 16, x + 70, 18):
            draw.line((gx, y + 4, gx, y + 38), fill=rgba((83, 137, 178), 180), width=2)
        draw.line((x + 4, y + 21, x + 68, y + 21), fill=rgba((83, 137, 178), 180), width=2)
        draw.line((x + 10, y - 4, x + 24, y - 14), fill=rgba((255, 235, 112), 200), width=3)


def draw_clock_upgrade(draw: ImageDraw.ImageDraw) -> None:
    draw.ellipse((88, 28, 168, 108), fill=rgba((242, 225, 168), 255), outline=rgba((101, 79, 49), 255), width=5)
    draw.line((128, 68, 128, 44), fill=rgba((61, 58, 54), 255), width=4)
    draw.line((128, 68, 146, 78), fill=rgba((61, 58, 54), 255), width=4)
    for x, y in [(72, 116), (184, 116), (72, 186), (184, 186)]:
        draw.ellipse((x - 16, y - 16, x + 16, y + 16), fill=rgba((255, 216, 106), 80))


TOWN_ASSETS = [
    ("construction_foundation", ["grass_field", "wild_meadow", "plaza_stone"], 1, draw_foundation, "Building foundation and survey stakes."),
    ("construction_scaffold", ["house_red", "house_blue", "shop_food", "shop_clothing", "shop_interior", "shop_pawn", "restaurant", "builder_shop", "farm_coop", "bank", "town_hall", "agent_hut"], 2, draw_scaffold, "Scaffold overlay for buildings under upgrade."),
    ("paved_border", ["grass_field", "wild_meadow", "plaza_stone"], 2, draw_paved_border, "Stone border showing upgraded public works."),
    ("street_lamps", ["plaza_stone"], 3, draw_lamps, "Street lamps for developed plazas."),
    ("flower_planters", ["plaza_stone", "grass_field"], 2, draw_planters, "Planters for beautification upgrades."),
    ("market_stalls", ["plaza_stone"], 3, draw_market_stalls, "Pop-up market stalls for a lively town center."),
    ("plaza_fountain", ["plaza_stone"], 4, draw_fountain, "Fountain centerpiece for a mature plaza."),
    ("benches", ["plaza_stone", "grass_field", "wild_meadow"], 2, draw_benches, "Benches for parks and waiting areas."),
    ("festival_lanterns", ["plaza_stone", "grass_field"], 4, draw_lanterns, "Festival lantern decoration layer."),
    ("signposts", ["grass_field", "wild_meadow"], 1, draw_signposts, "Wayfinding signs for early development."),
    ("irrigation_channels", ["farm_plot", "grass_field"], 2, draw_irrigation, "Water channels for developed farmland."),
    ("wooden_bridge", ["pond_edge"], 3, draw_bridge, "Small wooden bridge overlay."),
    ("solar_panels", ["house_red", "house_blue", "bank", "town_hall", "agent_hut"], 4, draw_solar, "Solar panel rooftop upgrade marker."),
    ("clock_tower_upgrade", ["town_hall", "plaza_stone"], 5, draw_clock_upgrade, "Civic clock and lights for high development."),
]


def crop_positions() -> list[tuple[int, int]]:
    return [(x, y) for y in (70, 104, 138, 172, 206) for x in (38, 76, 114, 152, 190, 228)]


def draw_leaf(draw: ImageDraw.ImageDraw, x: int, y: int, size: int, color: tuple[int, int, int]) -> None:
    draw.ellipse((x - size, y - size // 2, x + size, y + size // 2), fill=rgba(color, 255))
    draw.line((x - size, y, x + size, y), fill=rgba((49, 104, 42), 170), width=max(1, size // 5))


def draw_crop_overlay(crop: str, stage: int) -> Image.Image:
    img = blank()
    draw = ImageDraw.Draw(img, "RGBA")
    positions = crop_positions()

    for index, (x, y) in enumerate(positions):
        draw.ellipse((x - 10, y + 8, x + 10, y + 15), fill=rgba((61, 38, 25), 75))
        if stage == 0:
            draw.ellipse((x - 3, y + 3, x + 3, y + 9), fill=rgba((205, 161, 86), 230))
            continue
        if stage >= 1:
            draw.line((x, y + 8, x, y - 8 - stage * 3), fill=rgba((61, 132, 49), 255), width=3)
            draw_leaf(draw, x - 5, y - 2, 7 + stage, (83, 160, 54))
            draw_leaf(draw, x + 6, y - 8, 7 + stage, (101, 180, 65))
        if stage >= 2:
            draw_leaf(draw, x - 8, y - 16, 9, (63, 138, 57))
            draw_leaf(draw, x + 9, y - 20, 9, (89, 169, 65))
        if stage >= 3:
            if crop == "carrot":
                draw.polygon((x - 5, y + 3, x + 5, y + 3, x, y + 18), fill=rgba((230, 112, 43), 255))
            elif crop == "tomato":
                for ox, oy in [(-5, -15), (5, -11)]:
                    draw.ellipse((x + ox - 5, y + oy - 5, x + ox + 5, y + oy + 5), fill=rgba((221, 59, 48), 255))
            elif crop == "wheat":
                for oy in range(-28, -6, 5):
                    draw.ellipse((x - 6, y + oy, x + 2, y + oy + 8), fill=rgba((226, 184, 76), 255))
                    draw.ellipse((x - 1, y + oy, x + 7, y + oy + 8), fill=rgba((239, 203, 95), 255))
            elif crop == "cabbage":
                draw.ellipse((x - 12, y - 18, x + 12, y + 6), fill=rgba((118, 190, 79), 255), outline=rgba((64, 124, 57), 220), width=2)
                draw.arc((x - 8, y - 14, x + 8, y + 2), 40, 330, fill=rgba((74, 139, 65), 180), width=2)
            elif crop == "corn":
                draw.polygon((x - 5, y - 30, x + 7, y - 26, x + 4, y - 4, x - 7, y - 7), fill=rgba((241, 203, 64), 255))
                draw_leaf(draw, x - 7, y - 16, 11, (73, 148, 57))
            elif crop == "pumpkin":
                draw.ellipse((x - 14, y - 10, x + 14, y + 14), fill=rgba((225, 126, 42), 255), outline=rgba((144, 82, 34), 220), width=2)
                draw.arc((x - 8, y - 9, x + 8, y + 14), 80, 280, fill=rgba((166, 89, 35), 170), width=2)
            elif crop == "strawberry":
                draw.ellipse((x - 6, y - 15, x + 6, y - 1), fill=rgba((220, 54, 70), 255))
                draw.polygon((x - 6, y - 6, x + 6, y - 6, x, y + 6), fill=rgba((220, 54, 70), 255))
                draw.point((x - 2, y - 10), fill=rgba((255, 235, 130), 255))
            elif crop == "rice":
                for ox in (-5, 0, 5):
                    draw.line((x, y - 5, x + ox, y - 30), fill=rgba((212, 183, 76), 255), width=2)
                    draw.ellipse((x + ox - 2, y - 32, x + ox + 3, y - 26), fill=rgba((235, 211, 108), 255))

    return img


def save_crop_assets() -> list[dict[str, object]]:
    crops = [
        ("carrot", "Carrot"),
        ("tomato", "Tomato"),
        ("wheat", "Wheat"),
        ("cabbage", "Cabbage"),
        ("corn", "Corn"),
        ("pumpkin", "Pumpkin"),
        ("strawberry", "Strawberry"),
        ("rice", "Rice"),
    ]
    assets: list[dict[str, object]] = []
    for crop_id, label in crops:
        for stage in range(4):
            asset_id = f"{crop_id}_stage_{stage}"
            img = draw_crop_overlay(crop_id, stage)
            img.save(CROP_OUT / f"{asset_id}.png")
            assets.append(
                {
                    "id": asset_id,
                    "file": f"crops/{asset_id}.png",
                    "type": "crop_overlay",
                    "crop": crop_id,
                    "cropName": label,
                    "stage": stage,
                    "targetBase": ["farm_plot"],
                    "description": f"{label} growth stage {stage}.",
                    "collision": {"type": "none", "solid": False},
                }
            )
    return assets


def make_farm_soil_tile() -> Image.Image:
    img = Image.new("RGBA", (TILE, TILE), (114, 72, 38, 255))
    draw = ImageDraw.Draw(img, "RGBA")
    for y in range(18, TILE, 28):
        draw.rounded_rectangle((0, y - 8, TILE, y + 8), radius=8, fill=rgba((92, 57, 31), 255))
        draw.line((0, y + 9, TILE, y + 9), fill=rgba((139, 91, 49), 160), width=2)
    for x in range(16, TILE, 32):
        draw.line((x, 0, x - 12, TILE), fill=rgba((82, 52, 31), 40), width=2)
    for i in range(120):
        x = (i * 73) % TILE
        y = (i * 41 + 17) % TILE
        color = (144, 94, 50) if i % 3 else (74, 48, 31)
        draw.ellipse((x - 2, y - 1, x + 2, y + 1), fill=rgba(color, 110))
    img.putalpha(255)
    return img


def make_road_upgrade_tile(base_id: str, level: int) -> Image.Image:
    source = ROOT / "assets" / "town_blocks" / "seamless_tiles" / f"{base_id}.png"
    img = Image.open(source).convert("RGBA")
    draw = ImageDraw.Draw(img, "RGBA")

    if level == 1:
        for i in range(110):
            x = (i * 59 + len(base_id) * 13) % TILE
            y = (i * 37 + level * 29) % TILE
            color = (191, 175, 140) if i % 2 else (126, 108, 82)
            draw.ellipse((x - 3, y - 2, x + 3, y + 2), fill=rgba(color, 110))
        for y in range(30, TILE, 46):
            draw.line((0, y, TILE, y + 8), fill=rgba((226, 207, 159), 70), width=3)
    elif level == 2:
        for y in range(-24, TILE + 28, 28):
            offset = 14 if (y // 28) % 2 else 0
            for x in range(-28 + offset, TILE + 28, 56):
                rounded(draw, (x, y, x + 48, y + 22), rgba((174, 166, 147), 120), rgba((102, 96, 85), 95), 1, 5)
        for pos in (16, TILE - 18):
            draw.line((0, pos, TILE, pos), fill=rgba((236, 222, 177), 130), width=4)
    elif level == 3:
        draw.rounded_rectangle((-8, 20, TILE + 8, TILE - 20), radius=24, fill=rgba((116, 123, 119), 168))
        for y in (TILE // 2 - 16, TILE // 2 + 16):
            for x in range(18, TILE, 46):
                draw.rounded_rectangle((x, y - 3, x + 22, y + 3), radius=3, fill=rgba((248, 236, 173), 230))
        for pos in (24, TILE - 25):
            draw.line((0, pos, TILE, pos), fill=rgba((236, 236, 226), 150), width=3)
    elif level == 4:
        draw.rounded_rectangle((-10, 18, TILE + 10, TILE - 18), radius=28, fill=rgba((86, 101, 109), 184))
        for y in (58, 198):
            draw.line((0, y, TILE, y), fill=rgba((97, 216, 213), 150), width=5)
            draw.line((0, y, TILE, y), fill=rgba((237, 255, 249), 110), width=2)
        for x in range(16, TILE, 48):
            draw.rounded_rectangle((x, 118, x + 25, 138), radius=6, fill=rgba((238, 246, 216), 210))
    else:
        draw.rounded_rectangle((-12, 16, TILE + 12, TILE - 16), radius=30, fill=rgba((55, 72, 82), 205))
        for y in (48, 208):
            draw.line((0, y, TILE, y), fill=rgba((83, 235, 221), 205), width=6)
            draw.line((0, y, TILE, y), fill=rgba((238, 255, 250), 130), width=2)
        draw.line((0, TILE // 2, TILE, TILE // 2), fill=rgba((249, 239, 137), 210), width=4)
        for x in range(28, TILE, 54):
            draw.ellipse((x - 7, 121, x + 7, 135), fill=rgba((117, 244, 232), 130))
            draw.ellipse((x - 3, 125, x + 3, 131), fill=rgba((242, 255, 251), 230))

    img.putalpha(255)
    return img


def save_road_base_tiles() -> list[dict[str, object]]:
    road_bases = ["road_straight", "road_corner", "road_t", "road_cross", "dirt_path"]
    labels = {
        1: "compacted gravel road",
        2: "stone-paved road",
        3: "smooth paved road",
        4: "sensor-lit advanced road",
        5: "future mobility road",
    }
    assets: list[dict[str, object]] = []
    for base_id in road_bases:
        for level in range(1, 6):
            asset_id = f"{base_id}_level_{level}"
            img = make_road_upgrade_tile(base_id, level)
            img.save(BASE_OUT / f"{asset_id}.png")
            assets.append(
                {
                    "id": asset_id,
                    "file": f"base_tiles/{asset_id}.png",
                    "type": "road_base_tile",
                    "stage": level,
                    "targetBase": [base_id],
                    "description": f"{base_id} upgraded to {labels[level]}.",
                    "collision": {"type": "none", "solid": False},
                }
            )
    return assets


def preview_sheet(assets: list[dict[str, object]], cols: int, path: Path, base: Image.Image | None = None) -> None:
    rows = math.ceil(len(assets) / cols)
    sheet = Image.new("RGBA", (cols * TILE, rows * TILE), (248, 250, 241, 255))
    for i, asset in enumerate(assets):
        col = i % cols
        row = i // cols
        if base:
            sheet.alpha_composite(base, (col * TILE, row * TILE))
        img = Image.open(OUT / str(asset["file"])).convert("RGBA")
        sheet.alpha_composite(img, (col * TILE, row * TILE))
    sheet.convert("RGB").save(path)


def main() -> None:
    BASE_OUT.mkdir(parents=True, exist_ok=True)
    TOWN_OUT.mkdir(parents=True, exist_ok=True)
    CROP_OUT.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)

    town_assets = [
        save_town_asset(asset_id, target, stage, draw_fn, description)
        for asset_id, target, stage, draw_fn, description in TOWN_ASSETS
    ]
    crop_assets = save_crop_assets()
    road_base_tiles = save_road_base_tiles()

    farm_base = make_farm_soil_tile()
    farm_base.save(BASE_OUT / "farm_soil.png")
    plaza_base = Image.open(ROOT / "assets" / "town_blocks" / "seamless_tiles" / "plaza_stone.png").convert("RGBA")
    preview_sheet(town_assets, 7, DOCS / "town_development_overlays_preview.png", plaza_base)
    preview_sheet(crop_assets, 8, DOCS / "crop_growth_overlays_preview.png", farm_base)
    preview_sheet(road_base_tiles, 5, DOCS / "road_development_tiles_preview.png")

    META.write_text(
        json.dumps(
            {
                "tileSize": TILE,
                "anchor": {"x": 128, "y": 224},
                "rendering": "Draw seamless background tile first, then crop overlays, then town development overlays, then object sprites.",
                "baseTiles": [
                    {
                        "id": "farm_soil",
                        "file": "base_tiles/farm_soil.png",
                        "type": "gapless_base_tile",
                        "description": "Bare farm soil tile for crop growth overlays.",
                    },
                    *road_base_tiles,
                ],
                "assets": town_assets + crop_assets,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
