# Progression Layer Assets

These assets are transparent overlays for showing town growth on top of the gapless background tiles.

## Files

- `town/*.png`: town development overlays such as construction, benches, street lamps, market stalls, fountain, signs, and public works.
- `crops/*.png`: crop growth overlays for 8 crop types, each with stages `0` through `3`.
- `base_tiles/farm_soil.png`: gapless bare field base for crop growth overlays.
- `base_tiles/road_*_level_*.png`: gapless road base replacements for development levels `1` through `5`, from rough paving to future roads.
- `progression_layers.json`: metadata for target base tiles, stage numbers, and render order.
- `docs/town_development_overlays_preview.png`: town overlay preview composited over plaza tiles.
- `docs/crop_growth_overlays_preview.png`: crop overlay preview composited over farm tiles.
- `docs/road_development_tiles_preview.png`: road tile progression preview.

## Render Order

1. Draw `assets/town_blocks/seamless_tiles/<base>.png`, `base_tiles/farm_soil.png` for active crop fields, or the matching `base_tiles/road_*_level_*.png` for developed roads.
2. Draw crop overlays for farm plots.
3. Draw town development overlays, excluding road tiles.
4. Draw object sprites such as houses and shops.
5. Draw agents and UI markers.

This keeps background tiles gapless while allowing the map data to express development state with simple overlay IDs.
