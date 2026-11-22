from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAPS_JSON = ROOT / "assets" / "maps" / "town_maps.json"

BLOCKED_OBJECT_BASES = {
    "road_straight",
    "road_corner",
    "road_t",
    "road_cross",
    "dirt_path",
    "farm_plot",
    "pond_edge",
}

TERRAIN_DECORATION_OBJECTS = {
    "dense_forest",
    "forest_edge",
    "pond_edge",
}


def main() -> None:
    maps_doc = json.loads(MAPS_JSON.read_text(encoding="utf-8"))
    problems: list[str] = []

    for map_data in maps_doc["maps"]:
        legend = map_data["legend"]
        terrain = map_data["terrain"]
        occupied: dict[tuple[int, int], list[str]] = {}

        for item in map_data["objects"]:
            x = int(item["x"])
            y = int(item["y"])
            asset_id = str(item["asset"])
            if y < 0 or y >= len(terrain) or x < 0 or x >= len(terrain[y]):
                problems.append(f"{map_data['id']}: {asset_id} is outside the map at ({x}, {y})")
                continue

            base_id = legend[terrain[y][x]]
            if base_id in BLOCKED_OBJECT_BASES and asset_id not in TERRAIN_DECORATION_OBJECTS:
                problems.append(f"{map_data['id']}: {asset_id} sits on {base_id} at ({x}, {y})")

            occupied.setdefault((x, y), []).append(asset_id)

        for (x, y), assets in occupied.items():
            if len(assets) > 1:
                problems.append(f"{map_data['id']}: multiple objects at ({x}, {y}): {', '.join(assets)}")

    if problems:
        for problem in problems:
            print(problem)
        raise SystemExit(1)

    print("map validation ok")


if __name__ == "__main__":
    main()
