# Town Block Assets

This folder contains a 24-piece town block set for a cozy top-down simulation game.
The style is original: bright, rounded, toy-like, and family-friendly without copying a specific franchise.

## Files

- `source/town_blocks_atlas.png`: transparent 6x4 atlas, 1536x1024.
- `source/town_blocks_atlas_chromakey.png`: original generated chroma-key source.
- `sprites/*.png`: 24 individual transparent PNG sprites, each 256x256.
- `tiles/*.png`: 24 opaque background tile PNGs, each 256x256, with transparent padding filled so map backgrounds can be placed edge-to-edge.
- `seamless_tiles/*.png`: 24 opaque full-cell tile PNGs for gapless map backgrounds.
- `atlas.json`: sprite list, atlas cell coordinates, recommended layer, anchor, and simple collision rectangles.
- `docs/town_blocks_preview.png`: visual preview of the full set.
- `docs/town_blocks_seamless_tiles_preview.png`: visual preview of the gapless full-cell tile set.
- `docs/town_blocks_collision_overlay.png`: preview with red collision rectangles.

## Collision Recommendation

Yes, collision-friendly elements are worth including.
For this kind of town game, keep collision separate from the painted silhouette:

- Buildings use a simple base rectangle near the bottom of the sprite.
- Forest and pond blocks are solid rectangles approximating the playable boundary.
- Roads, plazas, grass, farm plots, and paths are passable.
- Use the `anchor` in `atlas.json` as the bottom-center placement point.

This keeps pathfinding, click targeting, and agent movement easy while allowing the art to stay soft and expressive.
