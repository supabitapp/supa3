#!/usr/bin/env node

// Renders the Android launcher and splash artwork from the Icon Composer SVG sources.
//
// Icon Composer exports already contain a rounded-square silhouette, and Android masks
// the central 72dp of a 108dp adaptive canvas, so exporting them as a foreground produces
// a double-framed icon with the letters cropped by the mask. Instead, each variant gets a
// full-bleed background layer (the artwork behind the wordmark) and a shared transparent
// foreground that keeps the wordmark inside the safe zone.
//
// The Android 12+ splash screen masks its icon to a circle covering the central two thirds
// of a 288dp canvas, which is the same proportion the launcher crops. Composing the two
// adaptive layers into one 288dp image therefore makes the splash frame the wordmark
// exactly like the launcher icon does.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

const ICON_VARIANTS = ["dev", "nightly", "prod"] as const;
type IconVariant = (typeof ICON_VARIANTS)[number];

// 108dp at xxxhdpi. Expo's prebuild derives every launcher density bucket from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi: the full Android 12+ splash canvas, so the icon needs no upscaling.
const SPLASH_CANVAS = 1152;
// Icon Composer's layer sources use a 128pt viewBox; the wordmark path spans this box.
const TEXT = { x: 25.69, y: 37.17, width: 76.4, height: 52.95 };
// Wordmark width as a fraction of the 108dp canvas. The visible area is 72dp (66dp
// guaranteed), so 0.48 leaves the letters at ~72% of the mask with room for the
// launcher's own zoom effects.
const WORDMARK_FRACTION = 0.48;
// Icon Composer places layers on a 1024pt canvas, so one unit of the 128pt sources is 8pt.
const COMPOSER_POINTS_PER_UNIT = 8;
// The background is the base the other layers are placed on. The wordmark and dev's annotations
// follow the Android wordmark sizing rather than the artwork's iOS framing.
const NON_OVERLAY_LAYERS = new Set(["background.svg", "text.svg", "annotations.svg"]);
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";

const IconComposerDocument = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      layers: Schema.Array(
        Schema.Struct({
          "image-name": Schema.String,
          position: Schema.Struct({
            scale: Schema.Number,
            "translation-in-points": Schema.Tuple([Schema.Number, Schema.Number]),
          }),
        }),
      ),
    }),
  ),
});
type IconComposerLayer = (typeof IconComposerDocument.Type)["groups"][number]["layers"][number];
const decodeIconComposerDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IconComposerDocument),
);

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const wordmarkTransform = (size: number) => {
  const scale = (size * WORDMARK_FRACTION) / TEXT.width;
  const tx = (size - TEXT.width * scale) / 2 - TEXT.x * scale;
  const ty = (size - TEXT.height * scale) / 2 - TEXT.y * scale;
  return `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})`;
};

const canvasSvg = (size: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${inner}</svg>`;

// The layer sources clip to a 10pt rounded rectangle for the iOS silhouette. Android
// applies its own mask, so the layer must bleed to the canvas edge.
const fullBleed = (svg: string) =>
  svg.replace(/<rect width="128" height="128" rx="10"\/>/, '<rect width="128" height="128"/>');

const rasterize = (layer: string, svg: string, size: number) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(size, size).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (
  layer: string,
  base: Buffer,
  overlays: ReadonlyArray<{ input: Buffer; left?: number; top?: number }>,
) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([...overlays])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const readIconSource = Effect.fn("androidIcons.readIconSource")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(
    path.join(repositoryRoot, "assets", variant, "app-icon.icon", file),
  );
});

const readLayerSource = (repositoryRoot: string, variant: IconVariant, file: string) =>
  readIconSource(repositoryRoot, variant, `Assets/${file}`);

// Embeds a layer where icon.json places it on the 128pt artwork. A data URL keeps each layer's
// SVG ids separate, and filters are dropped because Icon Composer ignores them.
const placedLayerImage = Effect.fn("androidIcons.placedLayerImage")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  layer: IconComposerLayer,
) {
  const file = layer["image-name"];
  const source = yield* readLayerSource(repositoryRoot, variant, file);
  const viewBox = source.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/);
  if (!viewBox) {
    return yield* new AndroidIconRenderError({ layer: file, cause: "missing viewBox" });
  }
  const {
    scale,
    "translation-in-points": [x, y],
  } = layer.position;
  const width = (Number(viewBox[1]) * scale) / COMPOSER_POINTS_PER_UNIT;
  const height = (Number(viewBox[2]) * scale) / COMPOSER_POINTS_PER_UNIT;
  const left = 64 + x / COMPOSER_POINTS_PER_UNIT - width / 2;
  const top = 64 + y / COMPOSER_POINTS_PER_UNIT - height / 2;
  const href = `data:image/svg+xml;base64,${Buffer.from(source.replace(/ filter="[^"]*"/g, "")).toString("base64")}`;
  return `<image x="${left}" y="${top}" width="${width}" height="${height}" href="${href}"/>`;
});

const renderForeground = Effect.fn("androidIcons.renderForeground")(function* (
  repositoryRoot: string,
  size: number,
) {
  const text = yield* readLayerSource(repositoryRoot, "prod", "text.svg");
  const paths = text.match(/<path[^>]*\/>/g) ?? [];
  return yield* rasterize(
    "foreground",
    canvasSvg(size, `<g transform="${wordmarkTransform(size)}">${paths.join("")}</g>`),
    size,
  );
});

// Launcher and splash masks only reveal the central two thirds, so the artwork is fitted there
// to keep the iOS framing. A full-bleed copy underneath fills the parallax margin.
const renderArtworkBackground = Effect.fn("androidIcons.renderArtworkBackground")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  size: number,
) {
  const layer = `${variant}-background`;
  const source = yield* readLayerSource(repositoryRoot, variant, "background.svg");
  const background = fullBleed(source);
  if (background === source) {
    return yield* new AndroidIconRenderError({
      layer,
      cause: "background.svg has no 128pt rounded frame to bleed",
    });
  }
  const document = yield* readIconSource(repositoryRoot, variant, "icon.json").pipe(
    Effect.flatMap(decodeIconComposerDocument),
    Effect.mapError((cause) => new AndroidIconRenderError({ layer: "icon.json", cause })),
  );
  // icon.json lists layers front to back.
  const overlays = document.groups
    .flatMap((group) => group.layers)
    .filter((overlay) => !NON_OVERLAY_LAYERS.has(overlay["image-name"]))
    .toReversed();
  const images = yield* Effect.forEach(overlays, (overlay) =>
    placedLayerImage(repositoryRoot, variant, overlay),
  );
  const bled = background.replace(/<\/svg>\s*$/, `${images.join("")}</svg>`);
  const visible = Math.round((size * 2) / 3);
  const inset = Math.round((size - visible) / 2);
  const margin = yield* rasterize(layer, bled, size);
  const artwork = yield* rasterize(layer, bled, visible);
  return yield* composite(layer, margin, [{ input: artwork, left: inset, top: inset }]);
});

const renderDevelopmentBackground = Effect.fn("androidIcons.renderDevelopmentBackground")(
  function* (repositoryRoot: string, size: number) {
    // The annotation layer shares the wordmark's coordinate space, so it is scaled and
    // centered the same way to keep the wireframe boxes around the letters.
    const annotations = yield* readLayerSource(repositoryRoot, "dev", "annotations.svg");
    const body = annotations.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    const background = yield* renderArtworkBackground(repositoryRoot, "dev", size);
    const overlay = yield* rasterize(
      "dev-annotations",
      canvasSvg(size, `<g transform="${wordmarkTransform(size)}">${body}</g>`),
      size,
    );
    return yield* composite("dev-background", background, [{ input: overlay }]);
  },
);

const renderBackground = Effect.fn("androidIcons.renderBackground")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  size: number,
) {
  switch (variant) {
    case "dev":
      return yield* renderDevelopmentBackground(repositoryRoot, size);
    case "nightly":
    case "prod":
      return yield* renderArtworkBackground(repositoryRoot, variant, size);
  }
});

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const write = Effect.fn("androidIcons.write")(function* (name: string, contents: Uint8Array) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  });
  yield* write(
    "android-icon-foreground.png",
    yield* renderForeground(repositoryRoot, ADAPTIVE_CANVAS),
  );
  const splashForeground = yield* renderForeground(repositoryRoot, SPLASH_CANVAS);
  for (const variant of ICON_VARIANTS) {
    yield* write(
      `android-icon-background-${variant}.png`,
      yield* renderBackground(repositoryRoot, variant, ADAPTIVE_CANVAS),
    );
    const splashBackground = yield* renderBackground(repositoryRoot, variant, SPLASH_CANVAS);
    yield* write(
      `android-splash-icon-${variant}.png`,
      yield* composite(`${variant}-splash`, splashBackground, [{ input: splashForeground }]),
    );
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
