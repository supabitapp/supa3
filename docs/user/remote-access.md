# Remote access

Connect a phone, browser, or another desktop app to Supacode running on a different
machine. That machine must stay running and reachable while you work.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
supacode serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
supacode pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, a public URL, SSH, or
T3 Connect. To add one, choose **Add route** in the machine's route list, or
next to it in the T3 Connect list. Pairing the same machine again over another
address also adds a route instead of a second machine. A new route is placed by
speed, in that order, and you can reorder routes at any time.

While connected through T3 Connect or a paired address, T3 Code also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through T3 Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

T3 Code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, T3 Code checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of T3 Connect removes only that route; a machine
you can still reach another way stays saved.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
supacode serve --tailscale-serve
```

For an already-running server:

```bash
supacode pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `supacode pair --help` for other pairing options.

### Hosted web app

A web app served over HTTPS needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. Supacode starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads Supacode's server to `~/.supacode/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that Supacode launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `supacode auth --help`.

A session with an open connection stays listed after its access credential
expires.

Treat pairing URLs and pairing codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. Supacode restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through paired environments or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
