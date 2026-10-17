import { createCipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express, { type Express, type Request } from 'express';
import { BridgeConnection, isTailscaleAddress } from './bridge-connection.js';
import { BridgeDiscovery, privateResponseHeaders } from './bridge-discovery.js';

const execFileAsync = promisify(execFile);
const PAIRING_MS = 5 * 60_000;
const RETAIN_EXPIRED_MS = 60_000;
const CODE_CONTEXT = 'petroglyphs-pairing-code-v1\n';
const KEY_CONTEXT = 'petroglyphs-wireless-pairing-v1';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type PairingState = 'pending' | 'rejected' | 'approved' | 'expired';
interface PairingEvent { event: 'requested' | 'approved' | 'rejected'; route: 'tailscale' | 'local' | 'loopback' }
interface EncryptedCredentials { nonce: string; ciphertext: string; tag: string }
interface PairingEntry {
  id: string;
  clientName: string;
  name: string;
  origin: string;
  pollHash: Buffer;
  approvalHash: Buffer;
  key: Buffer;
  code: string;
  expires: number;
  state: PairingState;
  route: PairingEvent['route'];
  encrypted?: EncryptedCredentials;
}
interface PairingOptions {
  now?: () => number;
  openApproval?: (url: string) => Promise<void>;
  onEvent?: (event: PairingEvent) => void;
}

class PairingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

function secretHash(value: string): Buffer { return createHash('sha256').update(value).digest(); }
function isLoopbackAddress(address: string | undefined): boolean { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? ''); }
function matchesSecret(value: unknown, expected: Buffer): boolean {
  return typeof value === 'string' && SECRET_PATTERN.test(value) && timingSafeEqual(secretHash(value), expected);
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function publicKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length !== 88 || !/^[A-Za-z0-9+/]{87}=$/.test(value)) return;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 65 && decoded[0] === 4 && decoded.toString('base64') === value ? decoded : undefined;
}

async function openApproval(url: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Local pairing approval requires macOS.');
  await execFileAsync('/usr/bin/open', [url], { timeout: 3000, maxBuffer: 1024 });
}

/** Pairing authorizes a client only after confirmation in a loopback Mac page.
 * ECDH protects the existing bearer on both LAN and Tailscale transports. The
 * short code is derived from that key, so a substituted public key changes it. */
export class BridgePairings {
  private readonly entries = new Map<string, PairingEntry>();
  private readonly attempts = new Map<string, { until: number; count: number }>();
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(readonly bridge: BridgeConnection, private readonly deviceToken: string, private readonly options: PairingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    for (const entry of this.entries.values()) entry.key.fill(0);
    this.entries.clear();
    this.attempts.clear();
  }

  private emit(entry: PairingEntry, event: PairingEvent['event']) {
    try { this.options.onEvent?.({ event, route: entry.route }); }
    catch { /* Diagnostics must not change an authorization decision. */ }
  }

  private sweep() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now >= entry.expires) {
        entry.state = 'expired'; entry.encrypted = undefined; entry.key.fill(0);
        if (now >= entry.expires + RETAIN_EXPIRED_MS) this.entries.delete(id);
      }
    }
    for (const [source, attempts] of this.attempts) if (now >= attempts.until) this.attempts.delete(source);
  }

  private rateLimit(source: string) {
    this.sweep();
    const current = this.attempts.get(source);
    if (current && current.count >= 5 || !current && this.attempts.size >= 256) {
      throw new PairingError('Too many pairing attempts. Try again in a minute.', 429, 'pairing_rate_limited');
    }
    this.attempts.set(source, { count: (current?.count ?? 0) + 1, until: current?.until ?? this.now() + 60_000 });
  }

  private async owns(origin: unknown, allowLoopback = true): Promise<boolean> {
    if (typeof origin !== 'string') return false;
    const metadata = await this.bridge.metadata();
    return [...metadata.lanOrigins, ...metadata.tailscaleOrigins, ...(allowLoopback ? [
      new URL(`http://127.0.0.1:${this.bridge.listenPort}`).origin,
      new URL(`http://localhost:${this.bridge.listenPort}`).origin] : [])].includes(origin);
  }

  async create(input: unknown, source: string) {
    this.rateLimit(source);
    const name = isRecord(input) && typeof input.clientName === 'string' ? input.clientName.trim() : '';
    const keyBytes = isRecord(input) ? publicKey(input.clientPublicKey) : undefined;
    if (!isRecord(input) || !name || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name) || !keyBytes || !await this.owns(input.origin, isLoopbackAddress(source))) {
      throw new PairingError('The pairing request is invalid.', 400, 'invalid_pairing');
    }
    const origin = input.origin as string;
    const ecdh = createECDH('prime256v1');
    const serverPublicKey = ecdh.generateKeys().toString('base64');
    let shared: Buffer;
    try { shared = ecdh.computeSecret(keyBytes); }
    catch { throw new PairingError('The pairing public key is invalid.', 400, 'invalid_pairing'); }
    const metadata = await this.bridge.metadata();
    const salt = randomBytes(32);
    const key = Buffer.from(hkdfSync('sha256', shared, salt, KEY_CONTEXT, 32));
    shared.fill(0);
    // Recheck after asynchronous interface reads so concurrent requests cannot
    // each pass the five-pending-request limit before either is inserted.
    this.sweep();
    if ([...this.entries.values()].filter(entry => entry.state === 'pending').length >= 5) {
      key.fill(0);
      throw new PairingError('The Mac already has pending pairing requests.', 429, 'pairing_busy');
    }
    const id = randomUUID(), pollToken = randomBytes(32).toString('base64url'), approvalToken = randomBytes(32).toString('base64url');
    const code = String(createHmac('sha256', key).update(`${CODE_CONTEXT}${id}`).digest().readUInt32BE(0) % 1_000_000).padStart(6, '0');
    const entry: PairingEntry = {
      id, clientName: name, name: metadata.name || 'Mac bridge', origin,
      pollHash: secretHash(pollToken), approvalHash: secretHash(approvalToken), key, code,
      expires: this.now() + PAIRING_MS, state: 'pending',
      route: isTailscaleAddress(source.replace(/^::ffff:/, '')) ? 'tailscale'
        : isLoopbackAddress(source) ? 'loopback' : 'local',
    };
    this.entries.set(id, entry);
    this.emit(entry, 'requested');
    try {
      await (this.options.openApproval ?? openApproval)(`http://127.0.0.1:${this.bridge.listenPort}/bridge/pairing/${id}?cap=${approvalToken}`);
    } catch {
      key.fill(0); this.entries.delete(id);
      throw new PairingError('The Mac could not open its pairing confirmation. Try again on the Mac.', 503, 'approval_unavailable');
    }
    return { id, pollToken, code, expiresAt: new Date(entry.expires).toISOString(), serverPublicKey, salt: salt.toString('base64') };
  }

  private authenticated(id: string, token: unknown, approval = false): PairingEntry {
    this.sweep();
    const entry = ID_PATTERN.test(id) ? this.entries.get(id) : undefined;
    if (!entry || !matchesSecret(token, approval ? entry.approvalHash : entry.pollHash)) {
      throw new PairingError('This pairing request is unavailable.', 404, 'pairing_not_found');
    }
    return entry;
  }

  poll(id: string, token: unknown) {
    const entry = this.authenticated(id, token);
    return { state: entry.state, ...(entry.state === 'approved' ? { encrypted: entry.encrypted } : {}) };
  }

  cancel(id: string, token: unknown) {
    const entry = this.authenticated(id, token);
    entry.state = 'rejected'; entry.encrypted = undefined; entry.key.fill(0);
    this.emit(entry, 'rejected');
  }

  approval(id: string, capability: unknown) {
    const entry = this.authenticated(id, capability, true);
    return { id: entry.id, clientName: entry.clientName, name: entry.name, code: entry.code, state: entry.state };
  }

  async decide(id: string, capability: unknown, decision: unknown) {
    const entry = this.authenticated(id, capability, true);
    if (decision !== 'allow' && decision !== 'reject') throw new PairingError('Choose Allow or Reject.', 400, 'invalid_decision');
    if (entry.state !== 'pending') return this.approval(id, capability);
    if (decision === 'reject') {
      entry.state = 'rejected'; entry.key.fill(0);
      this.emit(entry, 'rejected');
      return this.approval(id, capability);
    }
    const owned = await this.owns(entry.origin);
    this.sweep();
    if (entry.state !== 'pending') return this.approval(id, capability);
    if (!owned) {
      entry.state = 'expired'; entry.key.fill(0);
      return this.approval(id, capability);
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', entry.key, nonce);
    cipher.setAAD(Buffer.from(entry.id, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({
      baseURL: `${entry.origin}/device/${this.deviceToken}`, bridgeId: this.bridge.id, name: entry.name,
    }), 'utf8'), cipher.final()]);
    entry.encrypted = { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    entry.state = 'approved'; entry.key.fill(0);
    this.emit(entry, 'approved');
    return this.approval(id, capability);
  }
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function approvalHTML(entry: ReturnType<BridgePairings['approval']>, capability: string) {
  const pending = entry.state === 'pending';
  const message = { pending: 'Compare this code with the code shown on your iPad. Allow only if both codes match.',
    approved: 'This iPad can now connect. You can close this window.', rejected: 'The pairing request was rejected.', expired: 'This pairing request expired. Start again on your iPad.' }[entry.state];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with Petroglyphs</title>
<style>body{font:17px system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:24px;background:#f6f5f2;color:#222}main{background:white;border:1px solid #ddd;border-radius:20px;padding:28px}h1{font-size:26px}.code{font-size:42px;font-variant-numeric:tabular-nums;letter-spacing:8px;margin:24px 0}button{font:inherit;padding:12px 22px;border:1px solid #aaa;border-radius:10px;background:white;margin:8px 8px 0 0}button[value=allow]{background:#17603d;color:white;border-color:#17603d}</style></head>
<body><main><h1>Pair with ${escapeHTML(entry.name)}</h1><p>Device: <strong>${escapeHTML(entry.clientName)}</strong></p><p>${message}</p>
${pending ? `<div class="code" aria-label="Pairing code">${entry.code}</div><form method="post" action="/bridge/pairing/${entry.id}"><input type="hidden" name="cap" value="${escapeHTML(capability)}"><button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="reject">Reject</button></form>` : ''}</main></body></html>`;
}

export function loopbackApprovalRequest(req: Request, port: number, mutation: boolean): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const origin = req.headers.host === `127.0.0.1:${port}` ? `http://127.0.0.1:${port}`
    : req.headers.host === `localhost:${port}` ? `http://localhost:${port}` : undefined;
  if (!origin || (mutation ? req.headers.origin !== origin : req.headers.origin !== undefined && req.headers.origin !== origin)) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

export function installBridgePairingRoutes(app: Express, pairings: BridgePairings, discovery: BridgeDiscovery) {
  const publicRouter = express.Router();
  publicRouter.use(async (req, res, next) => {
    privateResponseHeaders(res);
    try {
      if (!await discovery.requestOrigin(req)) {
        res.status(403).json({ error: 'This pairing origin is not allowed.', code: 'origin_not_allowed' }); return;
      }
      next();
    } catch { res.status(503).json({ error: 'Pairing is temporarily unavailable.', code: 'pairing_unavailable' }); }
  });
  publicRouter.use(express.json({ limit: '8kb', strict: true }));
  publicRouter.post('/', async (req, res, next) => {
    try { res.status(201).json(await pairings.create(req.body, req.socket.remoteAddress ?? 'unknown')); }
    catch (error) { next(error); }
  });
  publicRouter.get('/:id', (req, res, next) => {
    try { res.json(pairings.poll(req.params.id, req.headers['x-pairing-token'])); }
    catch (error) { next(error); }
  });
  publicRouter.delete('/:id', (req, res, next) => {
    try { pairings.cancel(req.params.id, req.headers['x-pairing-token']); res.status(204).end(); }
    catch (error) { next(error); }
  });
  publicRouter.use(pairingErrorHandler);
  app.use('/api/bridge/pairings', publicRouter);

  const approvalRouter = express.Router();
  approvalRouter.use((req, res, next) => {
    privateResponseHeaders(res);
    // no-referrer makes browsers send Origin: null for this HTTP form POST.
    // Keep same-origin form provenance without disclosing the capability URL
    // to other origins; the socket, Host, Origin and capability checks remain.
    res.set({ 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Frame-Options': 'DENY' });
    if (!loopbackApprovalRequest(req, pairings.bridge.listenPort, req.method !== 'GET')) {
      res.status(403).type('text').send('Pairing confirmation must be opened on this Mac.'); return;
    }
    next();
  });
  approvalRouter.use(express.urlencoded({ extended: false, limit: '1kb', parameterLimit: 4 }));
  approvalRouter.get('/:id', (req, res, next) => {
    try { res.type('html').send(approvalHTML(pairings.approval(req.params.id, req.query.cap), req.query.cap as string)); }
    catch (error) { next(error); }
  });
  approvalRouter.post('/:id', async (req, res, next) => {
    try {
      const entry = await pairings.decide(req.params.id, req.body?.cap, req.body?.decision);
      res.type('html').send(approvalHTML(entry, req.body.cap));
    } catch (error) { next(error); }
  });
  approvalRouter.use(pairingErrorHandler);
  app.use('/bridge/pairing', approvalRouter);
}

const pairingErrorHandler: express.ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof PairingError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  const kind = isRecord(error) ? error.type : undefined;
  if (kind === 'entity.too.large') { res.status(413).json({ error: 'The pairing request is too large.', code: 'request_too_large' }); return; }
  if (kind === 'entity.parse.failed') { res.status(400).json({ error: 'The pairing request is invalid.', code: 'invalid_json' }); return; }
  res.status(503).json({ error: 'Pairing is temporarily unavailable.', code: 'pairing_unavailable' });
};
