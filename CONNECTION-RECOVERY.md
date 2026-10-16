# iPad connection recovery

The iPad keeps its original paired URL as the durable identity for selected chats,
drafts and pending request IDs. It changes only the network authority used for
requests. This layer connects the iPad to the paired Mac. It does not change the
Mac's Codex remote connection transport or its priority.

An authenticated `GET /device/<token>/api/health` includes:

```json
{"bridge":{"version":1,"id":"HMAC-derived identity","lanOrigins":["http://paired-mac.local:3333","http://192.168.1.20:3333"],"tailscaleOrigins":["http://100.64.0.10:3333"]}}
```

LAN candidates contain the Mac's `scutil --get LocalHostName` plus its current
private IPv4 addresses. Tailscale candidates must be returned by `tailscale ip -4`
and also present on a current local interface. The service does not publish other
tailnet machines, a token, or paths in this metadata. Hostname and Tailscale CLI
reads are cached for 60 seconds. Interface addresses are read for every proof.

Before sending the paired URL to any candidate, the iPad calls the public
`GET /api/bridge/identity?nonce=<64 lowercase hex>&origin=<origin>` without a token.
The reply is `{id,nonce,origin,proof}`. Both sides use the UTF-8 pairing token as
the HMAC-SHA256 key. The identity signs `petroglyphs-bridge-id-v1`. The proof signs
`petroglyphs-bridge-proof-v1\n<nonce>\n<origin>\n<id>`.

The bridge signs only its own advertised origins (plus loopback for local use).
This origin binding prevents another discovered machine from simply relaying a
nonce to the real bridge and then receiving the paired URL. The iPad checks all
four fields. It refuses redirects, arbitrary paths, queries, credentials,
different schemes/ports, public addresses and unexpected Tailscale ranges.

The iPad stores authenticated metadata in `UserDefaults`, under
`bridgeConnectionProfiles.v1`, indexed by SHA-256 of the logical paired base URL.
These profile values contain no token. The original paired URL still uses the
app's existing settings storage. A successful connection after upgrading is
required to learn fallback addresses. Paired URLs always require a valid identity
proof, including on their first connection. A missing identity endpoint fails
closed because an old DHCP address might now belong to another HTTP service.
Deliberately non-paired server URLs retain their existing direct behavior.

Recovery tries the LAN group first, with concurrent two-second identity probes,
then the Tailscale group. Each authenticated health request has a three-second
timeout. A verified connection is reused for up to ten seconds. The foreground
monitor refreshes every ten seconds, on a network-path change and when returning
to the foreground. It stops its timer in the background. After local connectivity
returns, the next probe prefers LAN again.

Business requests, including image/message POSTs and project-chat creation, are
never replayed by recovery. A failed request invalidates its route only if the
paired identity, endpoint and verification generation are still current. Late
failures cannot disconnect a newer route, even when it uses the same address.
The foreground monitor also checks its current paired identity before accepting
a failure notification. Existing request/receipt recovery decides the outcome
using the same request ID. This avoids duplicate Codex turns after an ambiguous
timeout.

The Server screen shows the current route, token-free endpoint and whether a
Tailscale backup has been learned. Both devices must have Tailscale connected and
tailnet access to the bridge port. The Mac bridge and Codex desktop must remain
running. HTTP on LAN retains the existing trusted-network assumption; the proof
is endpoint authentication, not payload encryption.

On iOS/iPadOS 17 and later, `NSAllowsLocalNetworking` alone does not permit HTTP
to Tailscale's `100.64.0.0/10` address range. The app declares an ATS
`NSExceptionAllowsInsecureHTTPLoads` exception for that CIDR range only. It keeps
`NSAllowsLocalNetworking` and does not enable global `NSAllowsArbitraryLoads`.
On the Tailscale route, HTTP travels inside Tailscale's encrypted tunnel. The ATS
exception does not establish trust in an endpoint: paired requests still require
the origin-bound HMAC proof, and candidate filtering and redirect rejection
remain enforced.

References: [Apple local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy),
[Apple local networking ATS exception](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking),
[Apple IP address and CIDR exceptions](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains),
[Tailscale stable addresses](https://tailscale.com/docs/concepts/ip-and-dns-addresses),
[Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli).
