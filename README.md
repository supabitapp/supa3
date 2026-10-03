# Supacode

Supacode runs coding agents on your computer and provides web, desktop, and mobile
clients for controlling them locally or remotely.

## Development

The checkout requires Node.js 24 and Mise-managed project tools.

### Install the development toolchain

Install Mise using the instructions below, then run these commands from the repository root:

#### macOS / Linux

```bash
curl https://mise.run | sh
```

#### Windows

```powershell
winget install jdx.mise
```

```bash
mise install --locked
mise exec -- vp i
mise exec -- vp run dev
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
architecture notes. Report bugs in the
[issue tracker](https://github.com/supabitapp/supacode-next/issues).

## Attribution

Supacode is a fork of https://github.com/pingdotgg/t3code
