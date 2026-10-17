import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CodexModelCatalogError, MODEL_CATALOG_TTL_MS, isRecord, isTailscaleIPv4, parseModelCatalogSnapshot,
  readLocalModelCatalog, readPrivateCatalogConfiguration, type ModelCatalogSnapshot,
} from './codex-model-catalog-source.js';

export interface ModelCatalogAgentConfiguration {
  codexPath: string;
  bindAddress: string;
  port: number;
  allowedSourceAddresses: string[];
}

export function parseModelCatalogAgentConfiguration(value: unknown): ModelCatalogAgentConfiguration {
  if (!isRecord(value) || Object.keys(value).some(key => !['codexPath', 'bindAddress', 'port', 'allowedSourceAddresses'].includes(key))
    || typeof value.codexPath !== 'string' || !isAbsolute(value.codexPath)
    || !isTailscaleIPv4(value.bindAddress) || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535
    || !Array.isArray(value.allowedSourceAddresses) || value.allowedSourceAddresses.length < 1 || value.allowedSourceAddresses.length > 8
    || value.allowedSourceAddresses.some(address => !isTailscaleIPv4(address))
    || new Set(value.allowedSourceAddresses).size !== value.allowedSourceAddresses.length) {
    throw new CodexModelCatalogError('Model catalogue agent configuration is invalid.', 503, 'invalid_configuration');
  }
  return { codexPath: value.codexPath, bindAddress: value.bindAddress, port: value.port as number,
    allowedSourceAddresses: [...value.allowedSourceAddresses] as string[] };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
  response.end(bytes);
}

/** The peer address comes only from the socket, never forwarding headers. */
export function createModelCatalogAgentHandler(configuration: ModelCatalogAgentConfiguration,
  reader?: () => Promise<ModelCatalogSnapshot>): (request: IncomingMessage, response: ServerResponse) => void {
  const config = parseModelCatalogAgentConfiguration(configuration);
  const allowed = new Set(config.allowedSourceAddresses);
  const read = reader ?? (() => readLocalModelCatalog({ codexPath: config.codexPath }));
  let snapshot: ModelCatalogSnapshot | undefined;
  let pending: Promise<ModelCatalogSnapshot> | undefined;
  const catalogue = (): Promise<ModelCatalogSnapshot> => {
    if (snapshot && Date.now() - Date.parse(snapshot.observedAt) < MODEL_CATALOG_TTL_MS) return Promise.resolve(snapshot);
    if (pending) return pending;
    snapshot = undefined;
    pending = Promise.resolve().then(read).then(value => {
      snapshot = parseModelCatalogSnapshot(value);
      return snapshot;
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return (request, response) => {
    const address = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (!address || !allowed.has(address)) {
      json(response, 403, { error: { code: 'forbidden', message: 'This peer is not allowed.' } }); return;
    }
    if (request.url !== '/models') {
      json(response, 404, { error: { code: 'not_found', message: 'Route not found.' } }); return;
    }
    if (request.method !== 'GET') {
      json(response, 405, { error: { code: 'method_not_allowed', message: 'Only GET is supported.' } }); return;
    }
    if (request.headers['transfer-encoding'] !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
      json(response, 400, { error: { code: 'invalid_request', message: 'This request must not have a body.' } }); return;
    }
    void catalogue().then(value => json(response, 200, value), () => {
      json(response, 503, { error: { code: 'catalogue_unavailable', message: 'The host model catalogue is unavailable.' } });
    });
  };
}

export async function startModelCatalogAgent(configuration: ModelCatalogAgentConfiguration): Promise<Server> {
  const config = parseModelCatalogAgentConfiguration(configuration);
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000 },
    createModelCatalogAgentHandler(config));
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: config.bindAddress, port: config.port, exclusive: true }, () => {
      server.removeListener('error', reject); resolve();
    });
  });
  return server;
}

async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') {
    throw new CodexModelCatalogError('Usage: node codex-model-catalog-agent.js --config /absolute/private.json', 503, 'invalid_configuration');
  }
  const config = parseModelCatalogAgentConfiguration(await readPrivateCatalogConfiguration(process.argv[3]));
  const server = await startModelCatalogAgent(config);
  const close = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  process.stdout.write('Model catalogue agent is listening on the configured Tailscale address.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    process.stderr.write(error instanceof CodexModelCatalogError ? `${error.message}\n` : 'Model catalogue agent could not start.\n');
    process.exitCode = 1;
  });
}
