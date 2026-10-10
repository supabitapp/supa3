# Supacode

A command center for your coding agents. Run it on the machine where your agents work, then control them from the desktop, web, or mobile app.

## Install

Desktop app: download it at https://next.supacode.sh.

iOS app: join the [TestFlight beta](https://testflight.apple.com/join/ga2vGT3h).

Command line on macOS and Linux:

```sh
curl -fsSL https://next.supacode.sh/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://next.supacode.sh/install.ps1 | iex
```

To try it without installing, run `npx supacode@latest`.

## Use

Open the desktop app, or run `supacode` to start the server and open the web app. Then enable a provider in **Settings → Providers**; its CLI must be installed and signed in on the same machine.

## Deploy on a host

To keep Supacode available on a Linux or macOS machine, install the command line there and use:

| Task                       | Command                    |
| -------------------------- | -------------------------- |
| Run in the background      | `supacode service install` |
| Check status and logs      | `supacode service status`  |
| Update to a newer release  | `supacode update`          |
| Remove the service and CLI | `supacode uninstall`       |

Then connect your phone or another computer with [remote access](./docs/user/remote-access.md).

## Documentation

Everything else is in the [docs](./docs/README.md).

## Attribution

Supacode is a fork of [t3code](https://github.com/pingdotgg/t3code).
