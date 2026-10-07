# Building the mobile Screens dependency

The mobile v5 stack uses a committed tarball built from the
[react-native-screens fork](https://github.com/juliusmarminge/react-native-screens/tree/t3-v5.0.0-t3.7)
maintained upstream. The fork owns the integration changes; the app does not
patch this package. Each archive includes compiled JavaScript, declarations,
native source and `t3-fork.json` recording its version, source commit and
upstream base.

To reproduce the current archive with Node 24 and the repository's pinned Yarn:

```sh
git clone --branch t3-v5.0.0-t3.7 https://github.com/juliusmarminge/react-native-screens.git /tmp/screens-fork
yarn --cwd /tmp/screens-fork pack:t3 /absolute/path/to/supacode/apps/mobile/deps
```

To update, take a newer tagged release of that fork (`t3-v<version>`), pack it
the same way, replace the old archive, update `apps/mobile/package.json` and
run `vp i` to regenerate the lockfile. Verify mobile types and affected
navigation tests. Changes to native source also require rebuilding and testing
the native client.
