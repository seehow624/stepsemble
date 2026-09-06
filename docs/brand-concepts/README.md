# Stepsemble B+ brand review record

Status: approved by Jerome on 2026-09-07 and promoted to the 3.0.7-rc.2 source
candidate. These files remain the visual comparison and export record; the
canonical vector sources now live in `public/`.

## Geometry

- Canvas: 1254 × 1254
- Rotation centre: 627, 627
- One ivory module and one blue-violet connector are reused at 0°, 90°, 180°
  and 270°.
- Standard mark scale: 0.92, producing equal 16% optical margins.
- Maskable icon scale: 0.82, providing additional room for operating-system
  circle and rounded-square crops.

## Review files

- `stepsemble-b-plus-review.png` — current-versus-B+ comparison board.
- `stepsemble-b-plus.svg` — dark-background app-icon master.
- `stepsemble-b-plus-mark.svg` — transparent full-colour mark.
- `stepsemble-b-plus-glyph.svg` — transparent single-colour mask source.
- `stepsemble-b-plus-maskable.svg` — maskable app-icon master.
- `stepsemble-b-plus-preview.png` — 1024 px candidate preview.
- `stepsemble-b-plus-icon-{512,180,32,16}.png` — standard raster sizes.
- `stepsemble-b-plus-mark-512.png` — transparent colour raster.
- `stepsemble-b-plus-glyph-512.png` — transparent monochrome raster.
- `stepsemble-b-plus-maskable-512.png` — maskable raster.

## Promotion record

The generated concept image was not copied into production. The approved shape
was rebuilt as one vector module plus one connector, both reused at exact
quarter-turns. Production promotion adds independent `any` and `maskable`
manifest assets, versioned cache entries and byte-integrity tests. Release and
deployment still require their normal verification gates.
