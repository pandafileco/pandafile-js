// Pandafile – the official JavaScript / TypeScript SDK. https://pandafile.co/developers/sdks
import { HttpClient, type ClientOptions, type RequestOptions, type RequestSpec } from './client.js';
import { MeResource, Keys, Domains, Transfers, FileRequests, Signatures, BrandingResource, TeamResource, Events, Hooks } from './resources.js';
import { webhooks } from './webhooks.js';

export class Pandafile {
  /** Webhook signature helpers: Pandafile.webhooks.verify(body, header, secret, toleranceSec). */
  static readonly webhooks = webhooks;
  readonly webhooks = webhooks;

  readonly me: MeResource;
  readonly keys: Keys;
  readonly domains: Domains;
  readonly transfers: Transfers;
  readonly requests: FileRequests;
  readonly signatures: Signatures;
  readonly branding: BrandingResource;
  readonly team: TeamResource;
  readonly events: Events;
  readonly hooks: Hooks;
  /** The HTTP layer (base URL, key, retries; lastResponse has the rate-limit headers of the last call). */
  readonly http: HttpClient;

  /** new Pandafile('pf_live_…') or new Pandafile({ apiKey, baseUrl, maxRetries, timeout, fetch }). */
  constructor(options: ClientOptions | string = {}) {
    this.http = new HttpClient(typeof options === 'string' ? { apiKey: options } : options);
    this.me = new MeResource(this.http);
    this.keys = new Keys(this.http);
    this.domains = new Domains(this.http);
    this.transfers = new Transfers(this.http);
    this.requests = new FileRequests(this.http);
    this.signatures = new Signatures(this.http);
    this.branding = new BrandingResource(this.http);
    this.team = new TeamResource(this.http);
    this.events = new Events(this.http);
    this.hooks = new Hooks(this.http);
  }

  /** true for a live key, false for a test key (pf_test_…). */
  get livemode(): boolean { return this.http.livemode; }

  /** Any API call by hand: pf.request('GET', '/me'). */
  request<T = unknown>(method: RequestSpec['method'], path: string, init: { query?: Record<string, unknown>; body?: unknown } & RequestOptions = {}): Promise<T> {
    const { query, body, ...opts } = init;
    return this.http.request<T>({ method, path, query, body }, opts);
  }
}

export default Pandafile;
export { HttpClient, DEFAULT_BASE_URL } from './client.js';
export type { ClientOptions, RequestOptions, RequestSpec, ApiResponse } from './client.js';
export * from './errors.js';
export { Page, PageRequest } from './pagination.js';
export { webhooks, verify as verifyWebhook, constructEvent, computeSignature, signatureHeader } from './webhooks.js';
export { tusUpload, encodeMetadata, DEFAULT_CHUNK_SIZE } from './tus.js';
export type { UploadSource, TusUploadOptions, TusUploadResult } from './tus.js';
export { prepareFiles, mimeOf } from './files.js';
export type { FileInput, FileData, PreparedFile } from './files.js';
export type { SendOptions, SendProgress, SendResult, SendState } from './send.js';
export { MeResource, Keys, Domains, Transfers, FileRequests, Signatures, BrandingResource, TeamResource, Events, Hooks } from './resources.js';
export { VERSION } from './version.js';
export * from './generated/types.js';
