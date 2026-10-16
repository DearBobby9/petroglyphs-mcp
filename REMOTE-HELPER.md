# Remote Codex helper

The central Mac forwards requests to another copy of this service on the remote machine. Each helper reads that machine's local Codex chats, saves the PNG there, queues its local Codex CLI, and serves the saved submission's reply. This does not use the Codex Desktop relay or its account credentials.

The iPad keeps the central Mac URL. The central Mac holds each helper URL and device token. Every send fixes both `hostId` and `threadId`. The remote receipt ID is retained for subsequent polling with that same `hostId`.

All machine addresses, host IDs and hostnames below are examples. Replace them with values from your own installation.

## Build the runtime archive

From the MCP repository, run:

```sh
npm run build
node --import tsx --test tests/remote-hosts.mjs
tar -czf /tmp/petroglyphs-remote-runtime.tar.gz \
  dist src/landing.html public package.json package-lock.json tests REMOTE-HELPER.md
shasum -a 256 /tmp/petroglyphs-remote-runtime.tar.gz
```

The archive must include `src/landing.html`. The compiled HTTP transport reads this file at startup. `npm pack` alone currently omits it. Include `public` for the static assets.

For this installation, add `private/seed.json` to a temporary, private provisioning archive. Its only field is a fresh `deviceToken` containing at least 32 lowercase hexadecimal characters. Use the same token in the central Mac's private host configuration. Do not add the seed to the repository or print it in deployment output.

Transfer the provisioning archive through the authorized private channel. Verify its SHA-256 on the remote machine before extraction. The example Mac mini destination is `100.64.0.20` on Tailscale. The example central Mac address is `100.64.0.10`. Replace these addresses before running the installation commands.

## Install on this Mac mini

The helper uses port `3335`, the launchd label `local.petroglyphs.remote-bridge`, and `~/Library/Application Support/PetroglyphsRemote`. It is separate from any local iPad service.

Set `PETRO_ARCHIVE` to the verified, downloaded provisioning archive. Run these commands as the Mac mini's logged-in user:

```sh
set -eu
umask 077
PETRO_ROOT="$HOME/Library/Application Support/PetroglyphsRemote"
PETRO_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/petroglyphs-remote.XXXXXX")"
export PETRO_ROOT PETRO_STAGE
test ! -e "$PETRO_ROOT/runtime"
mkdir -p "$PETRO_ROOT/data"
chmod 700 "$PETRO_ROOT" "$PETRO_ROOT/data"
tar -xzf "$PETRO_ARCHIVE" -C "$PETRO_STAGE"
cd "$PETRO_STAGE"
npm ci --omit=dev
test -f dist/index.js
test -f src/landing.html
test -f private/seed.json
mv "$PETRO_STAGE" "$PETRO_ROOT/runtime"
```

The `test ! -e` check protects an existing installation. For an update, first stop this helper and retain its previous runtime. Keep its `data` and private configuration files.

Create the private configuration and LaunchAgent:

```sh
python3 - <<'PY'
import json, os, pathlib, plistlib, re, shutil

root = pathlib.Path(os.environ['PETRO_ROOT'])
runtime = root / 'runtime'
node = shutil.which('node')
codex = shutil.which('codex')
if not node or not codex or not pathlib.Path(node).is_absolute() or not pathlib.Path(codex).is_absolute():
    raise SystemExit('Node.js and Codex must be installed and available in PATH.')
seed_path = runtime / 'private' / 'seed.json'
seed = json.loads(seed_path.read_text())
token = seed.get('deviceToken', '')
if not re.fullmatch(r'[0-9a-f]{32,256}', token):
    raise SystemExit('Invalid private deployment seed.')
config = root / 'auto-reply.json'
config.write_text(json.dumps({'deviceToken': token, 'codexPath': codex, 'dataDir': str(root / 'data')}, indent=2))
config.chmod(0o600)
seed_path.unlink()
launch = pathlib.Path.home() / 'Library' / 'LaunchAgents' / 'local.petroglyphs.remote-bridge.plist'
launch.parent.mkdir(parents=True, exist_ok=True)
plist = {
    'Label': 'local.petroglyphs.remote-bridge',
    'ProgramArguments': [node, str(runtime / 'dist' / 'index.js'), '--port', '3335', '--local-mcp'],
    'WorkingDirectory': str(runtime),
    'EnvironmentVariables': {
        'PATH': os.environ['PATH'],
        'PETROGLYPHS_AUTO_REPLY_CONFIG': str(config),
        'PETROGLYPHS_BIND_HOST': '100.64.0.20',
        'PETROGLYPHS_REQUIRE_DEVICE_AUTH': '1',
    },
    'RunAtLoad': True,
    'KeepAlive': True,
    'ProcessType': 'Background',
    'StandardOutPath': str(root / 'service.stdout.log'),
    'StandardErrorPath': str(root / 'service.stderr.log'),
}
launch.write_bytes(plistlib.dumps(plist))
launch.chmod(0o600)
print('Created private helper configuration and LaunchAgent.')
PY
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.petroglyphs.remote-bridge.plist"
```

Do not set `PETROGLYPHS_REMOTE_CONFIG` on this helper. Its requests target its own local Codex chats. The bind address limits the listener to Tailscale. `PETROGLYPHS_REQUIRE_DEVICE_AUTH=1` rejects all unpaired routes, including the landing page and MCP endpoint.

Read back the helper without printing its credential:

```sh
python3 - <<'PY'
import json, pathlib, urllib.error, urllib.request

root = pathlib.Path.home() / 'Library' / 'Application Support' / 'PetroglyphsRemote'
config = json.loads((root / 'auto-reply.json').read_text())
base = 'http://100.64.0.20:3335'
try:
    urllib.request.urlopen(base + '/api/health', timeout=10)
    raise SystemExit('Unauthenticated access was unexpectedly allowed.')
except urllib.error.HTTPError as error:
    if error.code != 403:
        raise SystemExit('Unexpected unauthenticated status.')
private = base + '/device/' + config['deviceToken']
try:
    with urllib.request.urlopen(private + '/api/health', timeout=10) as response:
        health = json.load(response)
    with urllib.request.urlopen(private + '/api/codex/threads', timeout=20) as response:
        threads = json.load(response)
except Exception:
    raise SystemExit('Authenticated helper check failed; inspect the local service log.')
if health.get('autoReply', {}).get('enabled') is not True or not isinstance(threads.get('threads'), list):
    raise SystemExit('Unexpected helper response.')
print(json.dumps({'privateHealth': 'ok', 'publicAccess': 'denied', 'threadCount': len(threads['threads'])}))
PY
```

This check proves authenticated listing. It does not prove image delivery or a completed Codex reply.

## Configure the central Mac

Create a file outside the repository, owned by the current user with mode `0600`. Set the central service's `PETROGLYPHS_REMOTE_CONFIG` to its absolute path. Its shape is:

```json
{
  "hosts": [
    {
      "id": "remote-control:env_e_00000000000000000000000000000001",
      "name": "Example-Mac-Mini.local",
      "url": "http://100.64.0.20:3335",
      "deviceToken": "REPLACE_WITH_THE_PRIVATE_SEED_TOKEN"
    }
  ]
}
```

The token placeholder is not a valid configuration value. Provision the real value from the private seed, without exposing it in chat, shell arguments, or logs. The base URL must have no path, query, credentials, or fragment. Plain HTTP is accepted only for loopback and Tailscale destinations. Other destinations require HTTPS. Redirects are rejected.

Restart the central service after changing this file. `GET /api/codex/hosts` then returns the configured helper and any other remote identities found in the local desktop cache. Cached-only entries remain unavailable. A configured entry permits a connection attempt; it does not assert that the machine is online.

The private APIs use `hostId` as follows:

- `GET /api/codex/threads?hostId=...` searches the selected helper's local Codex list.
- `POST /api/submit` accepts the PNG, metadata, `threadId`, and `hostId`.
- `GET /api/codex/submissions/ID?hostId=...` reads that same helper's submission.

The central service strips `hostId` and the local pairing code before forwarding. It sends no request to an unregistered URL. It validates the returned chat and receipt IDs. A failed or ambiguous POST is not retried automatically because the helper might already have accepted the image.

## Verify delivery and reply

After the central connection is configured, select the Mac mini and an explicitly authorized chat on iPad. Draw and send once. Record the returned `hostId`, `threadId`, and submission ID. Verify the PNG and receipt on the Mac mini. Verify that the selected Codex chat processed the same submission. Then verify the completed response appears on iPad with that original target.

Keep evidence for these states separate: archive received, helper running, authenticated list available, image saved, queue accepted, reply completed, and iPad displayed. Other remote machines require their own helper installation and private host entry.

To stop this helper, run:

```sh
launchctl bootout "gui/$(id -u)/local.petroglyphs.remote-bridge"
```

Remove its central host entry and restart the central service to remove its selectable transport. Keep saved data until its retention is decided.
