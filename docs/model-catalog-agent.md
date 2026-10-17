# Host model catalogue

The bridge reads each host's own Codex app-server catalogue. Local reads use the installed bundled CLI. Remote reads use a small HTTP agent on that host's Tailscale IPv4 address. Chat messages, images, settings changes and reply streaming continue to use the existing native Codex connection.

The agent has one route, `GET /models`. It starts a short-lived `codex app-server --listen stdio://`, sends `initialize` and paginated `model/list`, then closes the process. It sends no model turns. It does not read credentials directly, return model instructions, or expose a generic app-server proxy.

The returned capabilities are the host app-server's visible models. Desktop can apply additional UI filters. The observation timestamp records when the host answered. It does not claim that Codex bypassed its own internal cache.

## Build and install

Node.js 22 or later is required. Compile the two standalone modules:

```sh
./node_modules/.bin/tsc --strict --target ES2022 --module Node16 --moduleResolution Node16 --skipLibCheck --rootDir src --outDir dist src/codex-model-catalog-source.ts src/codex-model-catalog-agent.ts
```

Install these three files together in one directory on the remote host:

- `codex-model-catalog-source.js`, copied from `dist/`
- `codex-model-catalog-agent.js`, copied from `dist/`
- `package.json`, containing exactly `{"type":"module"}`

The JavaScript modules use only Node built-in modules. No `node_modules` directory is required. Verify both JavaScript file hashes after transfer. Use the destination's installed Node binary, not a binary copied from another architecture.

Create a configuration file owned by the service user with mode `0600`. Replace the example addresses with verified Tailscale device addresses. These example addresses are not deployment values.

```json
{
  "codexPath": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "bindAddress": "100.64.2.3",
  "port": 19765,
  "allowedSourceAddresses": ["100.64.2.4"]
}
```

Start the agent as the user whose Codex account and configuration should supply the catalogue:

```sh
/absolute/path/to/node /absolute/path/to/codex-model-catalog-agent.js --config /absolute/path/to/model-agent.json
```

The adjacent `package.json` makes Node load these files as ES modules. The process handles `SIGTERM` and `SIGINT` by closing its HTTP listener. A running catalogue read finishes or reaches its 15-second limit before its child exits.

The listener binds only the configured Tailscale IPv4 address. `0.0.0.0`, loopback, LAN addresses, DNS names and IPv6 are rejected. The source allowlist uses the socket peer address. Forwarded headers cannot supply identity. There is no extra token. The trust boundary is the authenticated Tailscale peer and its configured source address. Keep the allowlist limited to the bridge host and maintain the corresponding tailnet access rules.

If Tailscale has not assigned the configured address, startup fails. A supervisor may retry startup after the network becomes available. Do not change the binding to all interfaces.

## Bridge mapping

Set `PETROGLYPHS_MODEL_CATALOG_CONFIG` to an absolute path containing private `0600` JSON:

```json
{
  "hosts": [
    {
      "id": "remote-control:env_example",
      "url": "http://100.64.2.3:19765"
    }
  ]
}
```

Verify the host-to-device mapping during deployment. The adapter binds results to this configured host ID. It ignores any host ID supplied in a response. Each host and endpoint must be unique. URLs must use a literal Tailscale IPv4 address and an explicit port. Credentials, paths, queries, fragments, redirects and DNS names are rejected.

The bridge integration selects its local CLI with `PETROGLYPHS_MODEL_CODEX_PATH` when configured. Set that variable to the bundled CLI path shown above. The existing `settings.codexPath` can refer to an older Homebrew installation. Do not assume that these installations return the same catalogue. The remote agent has its own explicit `codexPath`.

The adapter itself accepts this integration input:

```ts
const catalog = await CodexModelCatalog.fromEnvironment({
  codexPath: process.env.PETROGLYPHS_MODEL_CODEX_PATH || settings.codexPath,
});
const result = await catalog.list(hostId);
await catalog.requireSelection(hostId, { model, reasoningEffort, hasImages });
```

Call `requireSelection` before a settings mutation or a new turn that applies these values. The validator checks the exact host model ID, the model's supported reasoning effort, text support, and image support when `hasImages` is true. A caller that inherits existing thread settings must obtain the effective model and effort before requesting this validation.

## Contracts and freshness

Agent success:

```ts
{
  version: 1,
  source: 'codex-app-server',
  observedAt: string, // UTC ISO timestamp
  models: Array<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
    defaultReasoningEffort: string;
    inputModalities: Array<'text' | 'image' | 'audio'>;
    isDefault: boolean;
  }>;
}
```

An unavailable source returns HTTP `503` with `{error:{code:'catalogue_unavailable',message:'The host model catalogue is unavailable.'}}`. Unauthorized peers receive `403`. Other paths receive `404`. Other methods receive `405`. Requests with bodies receive `400`. No error contains CLI stderr, account data or local paths.

Bridge success and failure share this envelope:

```ts
{
  hostId: string;
  status: 'available' | 'unavailable';
  source: 'local-app-server' | 'tailscale-model-agent' | null;
  observedAt: string | null;
  expiresAt: string | null;
  models: CatalogModel[];
  reason?: 'not_configured' | 'source_unavailable' | 'catalogue_stale' | 'invalid_catalogue';
}
```

The cache lasts five minutes from the original observation. An agent cache and a bridge cache do not add their lifetimes. Concurrent requests for one host share one read. After expiry, the bridge requests a fresh observation. A failed refresh returns `unavailable` with an empty model list. It never serves expired models or substitutes local models for a remote host. Responses dated over 30 seconds into the future are invalid, so both hosts must maintain their clocks.

`requireSelection` throws `CodexModelCatalogError` with `status` and a fixed `code`. Availability failures use `503`. Unsupported model, effort or input modality uses `400`, with `unsupported_model`, `unsupported_reasoning_effort` or `unsupported_input_modality`. Malformed selections use `unsupported_model`.

Reads are bounded by a 15-second deadline, ten pages, 256 models and a one-MiB normalized response. Redirects and automatic retries are disabled. The standalone agent allows at most eight connections.

## Verification

```sh
node --import tsx --test tests/model-catalog-source.mjs tests/model-catalog.mjs tests/model-catalog-agent.mjs
```

These tests cover process cleanup, pagination, hidden model exclusion, payload filtering, bounded failures, host isolation, TTL, selection validation, endpoint restrictions and the source-address allowlist. HTTP tests use temporary loopback listeners and simulate socket peer identity at the external transport boundary. Deployment acceptance must separately verify the real Tailscale binding and allowed peer. The listener and all test servers must be stopped when a temporary acceptance run finishes.
