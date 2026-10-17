import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Express, Request, Response } from 'express';
import { BridgeConnection, canonicalTailscaleDNSName, isLANAddress, isTailscaleAddress } from './bridge-connection.js';

const execFileAsync = promisify(execFile);
const CACHE_MS = 15_000;
const MAX_BRIDGES = 32;
const MAX_RESPONSE_BYTES = 16_384;

export interface DiscoveredBridge { id: string; name: string; origin: string }
interface TailscalePeer { ip: string; dnsName?: string }
interface TailscaleSnapshot { state: 'running' | 'unavailable'; peers: TailscalePeer[] }
interface DiscoveryOptions {
  readTailscaleStatus?: () => Promise<unknown>;
  fetchPeer?: (origin: string) => Promise<unknown>;
  now?: () => number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function privateBridgeOrigin(value: unknown, port: number): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'http:' || Number(url.port || 80) !== port || url.username || url.password) return;
    if (isLANAddress(url.hostname) || isTailscaleAddress(url.hostname) || canonicalTailscaleDNSName(url.hostname) === url.hostname
      || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(url.hostname)) return url.origin;
  } catch { /* An invalid candidate is not a bridge. */ }
}

function tailscaleSnapshot(value: unknown): TailscaleSnapshot {
  if (!record(value) || value.BackendState !== 'Running') return { state: 'unavailable', peers: [] };
  const peers = new Map<string, TailscalePeer>();
  for (const peer of record(value.Peer) ? Object.values(value.Peer) : []) {
    if (!record(peer) || peer.Online !== true || (peer.OS !== 'macOS' && peer.OS !== 'darwin') || !Array.isArray(peer.TailscaleIPs)) continue;
    for (const ip of peer.TailscaleIPs) {
      if (typeof ip === 'string' && isTailscaleAddress(ip) && !peers.has(ip)) {
        peers.set(ip, { ip, dnsName: canonicalTailscaleDNSName(peer.DNSName) });
      }
    }
  }
  return { state: 'running', peers: [...peers.values()] };
}

async function readTailscaleStatus(): Promise<unknown> {
  for (const binary of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    if (!await access(binary).then(() => true).catch(() => false)) continue;
    try {
      const { stdout } = await execFileAsync(binary, ['status', '--json'], { timeout: 1500, maxBuffer: 1_048_576 });
      return JSON.parse(stdout);
    } catch { /* Try the next installed CLI without logging tailnet metadata. */ }
  }
  return undefined;
}

async function fetchPeer(origin: string): Promise<unknown> {
  const response = await fetch(`${origin}/api/bridge/discovery?self=1`, {
    redirect: 'error', signal: AbortSignal.timeout(1000), headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) return;
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) { await response.body.cancel(); return; }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); return; }
      parts.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { reader.releaseLock(); }
}

/** Peer addresses come only from the local Tailscale daemon. A peer response can
 * describe that exact address but cannot redirect probes or name another host. */
export class BridgeDiscovery {
  private readonly now: () => number;
  private tailCache?: { expires: number; value: TailscaleSnapshot };
  private tailInFlight?: Promise<TailscaleSnapshot>;
  private peerCache?: { expires: number; bridges: DiscoveredBridge[] };
  private peersInFlight?: Promise<DiscoveredBridge[]>;

  constructor(readonly bridge: BridgeConnection, private readonly options: DiscoveryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private async tailscale(): Promise<TailscaleSnapshot> {
    if (this.tailCache && this.tailCache.expires > this.now()) return this.tailCache.value;
    this.tailInFlight ??= (this.options.readTailscaleStatus ?? readTailscaleStatus)().catch(() => undefined)
      .then(value => tailscaleSnapshot(value)).then(value => {
        this.tailCache = { value, expires: this.now() + CACHE_MS };
        return value;
      }).finally(() => { this.tailInFlight = undefined; });
    return this.tailInFlight;
  }

  /** No forwarded headers are trusted: these routes are served by the bridge. */
  async requestOrigin(req: Request): Promise<string | undefined> {
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length > 300 || /[\s/@?#\\]/.test(host)) return;
    let origin: string;
    try { origin = new URL(`http://${host}`).origin; } catch { return; }
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return;
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return;
    const metadata = await this.bridge.metadata();
    const port = this.bridge.listenPort;
    const owned = [...metadata.lanOrigins, ...metadata.tailscaleOrigins,
      new URL(`http://127.0.0.1:${port}`).origin, new URL(`http://localhost:${port}`).origin];
    if (owned.includes(origin)) return origin;
  }

  private async peers(status: TailscaleSnapshot, ownOrigins: string[]): Promise<DiscoveredBridge[]> {
    if (this.peerCache && this.peerCache.expires > this.now()) return this.peerCache.bridges;
    this.peersInFlight ??= (async () => {
      const candidates = status.peers.map(peer => ({ origin: `http://${peer.ip}:${this.bridge.listenPort}`,
        directoryOrigin: `http://${peer.dnsName ?? peer.ip}:${this.bridge.listenPort}` }))
        .filter(peer => !ownOrigins.includes(peer.origin)).slice(0, MAX_BRIDGES - 1);
      const found: (DiscoveredBridge | undefined)[] = new Array(candidates.length);
      let index = 0;
      const worker = async () => {
        while (index < candidates.length) {
          const current = index++, { origin, directoryOrigin } = candidates[current];
          try {
            const response = await (this.options.fetchPeer ?? fetchPeer)(origin);
            const peer = record(response) && response.version === 1 && record(response.bridge) ? response.bridge : undefined;
            if (peer && typeof peer.id === 'string' && /^[0-9a-f]{64}$/.test(peer.id)
              && typeof peer.name === 'string' && peer.name.trim().length > 0 && peer.name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(peer.name)
              && peer.origin === origin && privateBridgeOrigin(peer.origin, this.bridge.listenPort)) {
              // DNS is learned from the local daemon, never from peer JSON.
              // Keep probing the numeric IP to prevent response-driven SSRF.
              found[current] = { id: peer.id, name: peer.name, origin: directoryOrigin };
            }
          } catch { /* An unavailable or malformed peer is omitted. */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
      const bridges = found.filter((peer): peer is DiscoveredBridge => Boolean(peer));
      this.peerCache = { bridges, expires: this.now() + CACHE_MS };
      return bridges;
    })().finally(() => { this.peersInFlight = undefined; });
    return this.peersInFlight;
  }

  async read(selfOnly = false, requestedOrigin?: string) {
    const [metadata, status] = await Promise.all([this.bridge.metadata(), this.tailscale()]);
    const origins = [...metadata.tailscaleOrigins, ...metadata.lanOrigins];
    const origin = requestedOrigin && origins.includes(requestedOrigin) ? requestedOrigin : origins[0];
    if (!origin) throw new Error('No private interface is available.');
    const bridge: DiscoveredBridge = { id: metadata.id, name: metadata.name || 'Mac bridge', origin };
    const peers = selfOnly ? [] : await this.peers(status, origins);
    // The request-facing identity keeps its exact origin for peer validation.
    // The picker directory prefers the same Mac's tailnet route when present.
    const directoryBridge = { ...bridge, origin: metadata.tailscaleOrigins[0] ?? bridge.origin };
    const unique = new Map<string, DiscoveredBridge>([[bridge.id, directoryBridge]]);
    for (const peer of peers) if (!unique.has(peer.id)) unique.set(peer.id, peer);
    return { version: 1 as const, bridge, bridges: [...unique.values()].slice(0, MAX_BRIDGES),
      tailscale: { state: status.state, availablePeers: status.peers.length } };
  }
}

export function privateResponseHeaders(res: Response) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
}

export function installBridgeDiscoveryRoute(app: Express, discovery: BridgeDiscovery | undefined) {
  app.get('/api/bridge/discovery', async (req, res) => {
    privateResponseHeaders(res);
    if (!discovery) { res.status(404).json({ error: 'Bridge discovery is unavailable.', code: 'discovery_unavailable' }); return; }
    try {
      const origin = await discovery.requestOrigin(req);
      if (!origin) { res.status(403).json({ error: 'This discovery origin is not allowed.', code: 'origin_not_allowed' }); return; }
      if (req.query.self !== undefined && req.query.self !== '1') {
        res.status(400).json({ error: 'Invalid discovery query.', code: 'invalid_query' }); return;
      }
      res.json(await discovery.read(req.query.self === '1', origin));
    } catch { res.status(503).json({ error: 'Bridge discovery is temporarily unavailable.', code: 'discovery_unavailable' }); }
  });
}

/** dns-sd remains attached to this process and is stopped on HTTP close and on
 * termination. It publishes only the bridge identity, never pairing secrets. */
export async function advertiseBridge(bridge: BridgeConnection): Promise<() => void> {
  if (process.platform !== 'darwin' || process.env.PETROGLYPHS_BONJOUR === '0') return () => {};
  const metadata = await bridge.metadata();
  let child: ChildProcess | undefined = spawn('/usr/bin/dns-sd', ['-R', metadata.name || 'Mac bridge', '_petroglyphs._tcp', 'local',
    String(bridge.listenPort), 'version=1', `id=${bridge.id}`], { stdio: 'ignore' });
  child.on('error', () => { child = undefined; });
  const close = () => {
    child?.kill('SIGTERM');
    child = undefined;
    process.off('exit', close);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
  const signal = (name: NodeJS.Signals) => {
    close();
    if (!process.listenerCount(name)) process.kill(process.pid, name);
  };
  const interrupt = () => signal('SIGINT'), terminate = () => signal('SIGTERM');
  process.once('exit', close);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  return close;
}
