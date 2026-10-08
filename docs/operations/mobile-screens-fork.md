# Mobile navigation dependency

Supacode pins `react-native-screens` through the archive in `apps/mobile/deps`.
The archive comes from [this source commit](https://github.com/juliusmarminge/react-native-screens/commit/e24d2002a64e8b1868ffb483b55500d29e313ddf),
with [this base revision](https://github.com/software-mansion/react-native-screens/commit/eaf8d118f77976a7978581bf94a5fe199bb0a64a).
It includes compiled JavaScript, declarations, native source, and a provenance record.
The archive supplies the native stack, form-sheet, and column integration used by the mobile client.

An archive update requires a native client rebuild. The fingerprint hashes the pinned archive
alongside Supacode's existing native-patch inputs, so an OTA cannot introduce JavaScript that
requires a different native implementation. Keep those fingerprint inputs when changing the
pinned package.

Hashing every installed native-module directory also includes generated files in shared
dependencies. Metro and native builds can change those files between fingerprint reads, so
the archive digest supplies the stable input for the vendored Screens dependency.

Update the archive path in `apps/mobile/package.json` and regenerate the lockfile with `vp i`.
Validate the navigation projection tests and the native clients before publishing an update.
