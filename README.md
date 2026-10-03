# supa3

supa3 runs coding agents on your computer and provides web, desktop, and mobile
clients for controlling them locally or remotely.

## Development

The checkout requires Node.js 24 and Vite+ (`vp`). Install `vp` using the
[Vite+ installation guide](https://viteplus.dev/guide/).

From the repository root:

```bash
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. See the
[development runbook](./docs/operations/development.md) for desktop builds,
isolated state, and remote debugging, and the [mobile README](./apps/mobile/README.md)
for native clients.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- [Background service](./docs/user/background-service.md)

The [documentation index](./docs/README.md) includes provider guides and internal
architecture notes. Report bugs in the fork's
[issue tracker](https://github.com/supabitapp/supa3/issues).

## Attribution

supa3 is a fork of the [upstream project](https://github.com/pingdotgg/t3code).
The [MIT license](./LICENSE) and third-party notices retain their original attribution.
