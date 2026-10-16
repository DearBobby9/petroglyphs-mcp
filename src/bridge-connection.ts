import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import type { Express } from 'express';

const execFileAsync = promisify(execFile);
export interface BridgeConnectionMetadata {
  version: 1;
  id: string;
  lanOrigins: string[];
  tailscaleOrigins: string[];
}

interface NetworkSnapshot { localHostname?: string; addresses: string[]; tailscaleAddresses: string[] }

function ipv4(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return;
  return parts.map(Number);
}

export function isLANAddress(address: string): boolean {
  const parts = ipv4(address);
  return !!parts && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168));
}

export function isTailscaleAddress(address: string): boolean {
  const parts = ipv4(address);
  return !!parts && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** A token-free identity proof must name an address this machine actually owns.
 * Binding the proof to that origin prevents a discovered peer from relaying a
 * challenge to the real bridge and then receiving the paired URL itself. */
export class BridgeConnection {
  readonly id: string;
  private port = 0;

  constructor(private readonly token: string, private readonly snapshot: () => Promise<NetworkSnapshot> = localNetworkSnapshot) {
    this.id = createHmac('sha256', token).update('petroglyphs-bridge-id-v1').digest('hex');
  }

  setPort(port: number) { this.port = port; }

  async metadata(): Promise<BridgeConnectionMetadata> {
    const snapshot = await this.snapshot();
    const origin = (host: string) => new URL(`http://${host}:${this.port}`).origin;
    const hostname = snapshot.localHostname?.toLowerCase().replace(/\.local\.?$/, '');
    const lan = snapshot.addresses.filter(isLANAddress);
    const tail = snapshot.tailscaleAddresses.filter(ip => isTailscaleAddress(ip) && snapshot.addresses.includes(ip));
    return {
      version: 1, id: this.id,
      lanOrigins: [...new Set([
        ...(hostname && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname) ? [origin(`${hostname}.local`)] : []),
        ...lan.map(origin),
      ])].slice(0, 5),
      tailscaleOrigins: [...new Set(tail.map(origin))].slice(0, 2),
    };
  }

  async proof(nonce: unknown, origin: unknown) {
    if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce) || typeof origin !== 'string') return;
    const metadata = await this.metadata();
    const localOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`].map(value => new URL(value).origin);
    if (![...metadata.lanOrigins, ...metadata.tailscaleOrigins, ...localOrigins].includes(origin)) return;
    const message = `petroglyphs-bridge-proof-v1\n${nonce}\n${origin}\n${this.id}`;
    return { id: this.id, nonce, origin, proof: createHmac('sha256', this.token).update(message).digest('hex') };
  }
}

export function installBridgeIdentityRoute(app: Express, bridge: BridgeConnection | undefined) {
  // This is intentionally the sole token-free bridge route. It exposes neither
  // addresses nor the bearer token, and works with REQUIRE_DEVICE_AUTH enabled.
  app.get('/api/bridge/identity', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!bridge) { res.status(404).json({ error: 'Bridge identity is unavailable.' }); return; }
    try {
      const proof = await bridge.proof(req.query.nonce, req.query.origin);
      if (!proof) { res.status(400).json({ error: 'Invalid bridge identity challenge.' }); return; }
      res.json(proof);
    } catch {
      res.status(503).json({ error: 'Bridge identity is temporarily unavailable.' });
    }
  });
}

let cachedNames: { expires: number; localHostname?: string; tailscaleAddresses: string[] } | undefined;
let namesInFlight: Promise<void> | undefined;

async function refreshNames() {
  const localHostname = process.platform === 'darwin'
    ? await execFileAsync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 1000, maxBuffer: 1024 }).then(result => result.stdout.trim()).catch(() => undefined)
    : undefined;
  let tailscaleAddresses: string[] = [];
  for (const binary of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale']) {
    if (!await access(binary).then(() => true).catch(() => false)) continue;
    tailscaleAddresses = await execFileAsync(binary, ['ip', '-4'], { timeout: 1500, maxBuffer: 2048 })
      .then(result => result.stdout.trim().split(/\s+/).filter(isTailscaleAddress)).catch(() => []);
    if (tailscaleAddresses.length) break;
  }
  cachedNames = { expires: Date.now() + 60_000, localHostname, tailscaleAddresses };
}

async function localNetworkSnapshot(): Promise<NetworkSnapshot> {
  if (!cachedNames || cachedNames.expires < Date.now()) {
    namesInFlight ??= refreshNames().finally(() => { namesInFlight = undefined; });
    await namesInFlight;
  }
  // Read interface addresses every time, so an old DHCP lease cannot remain a
  // signed candidate after the interface has moved to another address.
  const addresses = Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
  return { addresses, localHostname: cachedNames?.localHostname, tailscaleAddresses: cachedNames?.tailscaleAddresses ?? [] };
}
