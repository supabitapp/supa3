# Brand icons

The three shared Icon Composer projects are the source of truth for exported application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Production iOS uses the native icon bundle at [`apps/mobile/assets/AppIcon.icon`](../apps/mobile/assets/AppIcon.icon). The shared production PNG remains the source for its splash screen and fallback exports. The export and check scripts below cover the shared projects.

Each project uses `text.svg` for the Supacode mark and `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

The desktop app needs each macOS icon as a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native shadow extending into the surrounding transparent canvas.

Icon Composer does not produce that file. Its command-line `macOS` export is full bleed, and in Icon Composer 27 the app's `macOS pre-Tahoe` export preset is full bleed too. The export script therefore leaves the tracked macOS PNGs unchanged and prints a reminder after every run.

Render them with Xcode's asset compiler instead, which builds the classic rendition that macOS shows before Tahoe. `actool` only accepts an icon named `AppIcon`, so it compiles a copy. For nightly:

```bash
work=$(mktemp -d)
cp -R assets/nightly/app-icon.icon "$work/AppIcon.icon"
xcrun actool "$work/AppIcon.icon" --compile "$work" --platform macosx \
  --minimum-deployment-target 11.0 --app-icon AppIcon --include-all-app-icons \
  --standalone-icon-behavior all --output-partial-info-plist "$work/partial.plist"
iconutil -c iconset "$work/AppIcon.icns" -o "$work/AppIcon.iconset"
cp "$work/AppIcon.iconset/icon_512x512@2x.png" assets/nightly/nightly-macos-1024.png
```

The destinations are:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

Do not resize, composite, or otherwise post-process the rendered PNG, and do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: the variant's
  `background.svg` fitted into the masked central two thirds, over a full-bleed copy that fills
  the parallax margin. Dev also draws `annotations.svg` in the wordmark's coordinate space so the
  wireframe boxes stay around the letters. Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. `android-icon-mark.png` remains a flat silhouette for
Android's monochrome themed icon.
