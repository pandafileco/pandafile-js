// One class per API area. Every method maps to one operation of the OpenAPI document (operationId in the comment).
import type { HttpClient, RequestOptions } from './client.js';
import { PageRequest } from './pagination.js';
import type * as T from './generated/types.js';
import { mimeOf } from './files.js';
import { PandafileError } from './errors.js';
import { isNode } from './util.js';
import { sendTransfer, type SendOptions, type SendResult } from './send.js';

const enc = encodeURIComponent;
type Query = Record<string, unknown>;

abstract class Resource {
  constructor(protected readonly client: HttpClient) {}
  protected _get<R>(path: string, query?: Query, opts?: RequestOptions) { return this.client.request<R>({ method: 'GET', path, query }, opts); }
  protected _post<R>(path: string, body?: unknown, opts?: RequestOptions) { return this.client.request<R>({ method: 'POST', path, body: body ?? {} }, opts); }
  protected _patch<R>(path: string, body: unknown, opts?: RequestOptions) { return this.client.request<R>({ method: 'PATCH', path, body }, opts); }
  protected _del<R>(path: string, opts?: RequestOptions) { return this.client.request<R>({ method: 'DELETE', path }, opts); }
  protected _list<I>(path: string, params: Query = {}, opts?: RequestOptions): PageRequest<I> {
    const { starting_after, ...rest } = params as Query & { starting_after?: string };
    return new PageRequest<I>((after) => this._get<T.ListResponse<I>>(path, { ...rest, starting_after: after }, opts), starting_after);
  }
}

export type BinaryInput = Uint8Array | ArrayBuffer | Blob | string;

// A raw body from bytes, a Blob, or (Node) a file path.
async function rawBody(input: BinaryInput, fallbackType: string): Promise<{ data: Uint8Array | Blob | ArrayBuffer; contentType: string; name?: string }> {
  if (typeof input === 'string') {
    if (!isNode) throw new PandafileError({ message: 'File paths only work in Node.', code: 'path_unsupported' });
    const fs = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:fs/promises' as string);
    const path = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:path' as string);
    const t = mimeOf(input);
    return { data: new Uint8Array(await fs.readFile(input)), contentType: t === 'application/octet-stream' ? fallbackType : t, name: path.basename(input) };
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) return { data: input, contentType: input.type || fallbackType, name: (input as Blob & { name?: string }).name };
  return { data: input, contentType: fallbackType };
}

export class MeResource extends Resource {
  /** getMe – the key's account: plan, limits, usage, key mode and scope. */
  retrieve(opts?: RequestOptions) { return this._get<T.GetMeResponse>('/me', undefined, opts); }
  /** Alias of retrieve(). */
  get(opts?: RequestOptions) { return this.retrieve(opts); }
}

export class Keys extends Resource {
  /** listApiKeys */
  list(params: T.ListApiKeysParams = {}, opts?: RequestOptions) { return this._list<T.ApiKey>('/keys', params as Query, opts); }
}

export class Domains extends Resource {
  /** listDomains */
  list(params: T.ListDomainsParams = {}, opts?: RequestOptions) { return this._list<T.Domain>('/domains', params as Query, opts); }
  /** getDomain */
  retrieve(id: number | string, opts?: RequestOptions) { return this._get<T.GetDomainResponse>(`/domains/${enc(String(id))}`, undefined, opts); }
}

export class Transfers extends Resource {
  /** createTransfer – announce the files; then upload with tus and complete(). Most people want send(). */
  create(body: T.CreateTransferBody, opts?: RequestOptions) { return this._post<T.CreateTransferResponse>('/transfers', body, opts); }
  /** createTransferFromUrl – Pandafile downloads each https URL itself and completes the transfer (201 ready, or 202 while big files keep downloading). */
  fromUrl(body: T.CreateTransferFromUrlBody, opts?: RequestOptions) { return this._post<T.CreateTransferFromUrlResponse>('/transfers/from-url', body, opts); }
  /** getTransferImport – progress of a fromUrl() transfer that is still downloading. */
  importStatus(id: string, opts?: RequestOptions) { return this._get<T.GetTransferImportResponse>(`/transfers/${enc(id)}/import`, undefined, opts); }
  /** listTransfers – newest first; iterate for every page. */
  list(params: T.ListTransfersParams = {}, opts?: RequestOptions) { return this._list<T.Transfer>('/transfers', params as Query, opts); }
  /** getTransfer – files, recipients, downloads, approvals and stats. */
  retrieve(id: string, opts?: RequestOptions) { return this._get<T.GetTransferResponse>(`/transfers/${enc(id)}`, undefined, opts); }
  /** updateTransfer – title, message, expiry (expires_at / extend), password. */
  update(id: string, body: T.UpdateTransferBody, opts?: RequestOptions) { return this._patch<T.UpdateTransferResponse>(`/transfers/${enc(id)}`, body, opts); }
  /** deleteTransfer – deletes the files now. */
  delete(id: string, opts?: RequestOptions) { return this._del<T.DeleteTransferResponse & { id?: string; deleted?: boolean }>(`/transfers/${enc(id)}`, opts); }
  /** completeTransfer – after every file is uploaded: the link goes live, recipients are emailed. */
  complete(id: string, body: T.CompleteTransferBody, opts?: RequestOptions) { return this._post<T.CompleteTransferResponse>(`/transfers/${enc(id)}/complete`, body, opts); }
  /** addTransferRecipients */
  addRecipients(id: string, emails: string[] | string, opts?: RequestOptions) { return this._post<T.AddTransferRecipientsResponse>(`/transfers/${enc(id)}/recipients`, { emails }, opts); }
  /** remindTransferRecipient */
  remind(id: string, email: string, opts?: RequestOptions) { return this._post<T.RemindTransferRecipientResponse>(`/transfers/${enc(id)}/remind`, { email }, opts); }
  /** listTransferDownloads */
  downloads(id: string, params: T.ListTransferDownloadsParams = {}, opts?: RequestOptions) { return this._list<T.Download>(`/transfers/${enc(id)}/downloads`, params as Query, opts); }
  /** getTransferStats */
  stats(id: string, opts?: RequestOptions) { return this._get<T.GetTransferStatsResponse>(`/transfers/${enc(id)}/stats`, undefined, opts); }
  /** getTransferFeedback */
  feedback(id: string, opts?: RequestOptions) { return this._get<T.GetTransferFeedbackResponse>(`/transfers/${enc(id)}/feedback`, undefined, opts); }

  /**
   * Create a transfer, upload every file (resumable tus, chunked, several files in parallel) and complete it.
   * Returns the share link.
   *
   *   const { url } = await pf.transfers.send({ files: ['film.mov', 'stills/'], recipients: ['client@example.com'] });
   */
  send(options: SendOptions): Promise<SendResult> { return sendTransfer(this.client, this, options); }
}

export class FileRequests extends Resource {
  /** createFileRequest – an upload page people can send files to. */
  create(body: T.CreateFileRequestBody, opts?: RequestOptions) { return this._post<T.CreateFileRequestResponse>('/requests', body, opts); }
  /** listFileRequests */
  list(params: T.ListFileRequestsParams = {}, opts?: RequestOptions) { return this._list<T.FileRequest>('/requests', params as Query, opts); }
  /** getFileRequest */
  retrieve(id: string, opts?: RequestOptions) { return this._get<T.GetFileRequestResponse>(`/requests/${enc(id)}`, undefined, opts); }
  /** updateFileRequest */
  update(id: string, body: T.UpdateFileRequestBody, opts?: RequestOptions) { return this._patch<T.UpdateFileRequestResponse>(`/requests/${enc(id)}`, body, opts); }
  /** deleteFileRequest */
  delete(id: string, opts?: RequestOptions) { return this._del<T.DeleteFileRequestResponse>(`/requests/${enc(id)}`, opts); }
  /** closeFileRequest */
  close(id: string, opts?: RequestOptions) { return this._post<T.CloseFileRequestResponse>(`/requests/${enc(id)}/close`, {}, opts); }
  /** reopenFileRequest */
  reopen(id: string, opts?: RequestOptions) { return this._post<T.ReopenFileRequestResponse>(`/requests/${enc(id)}/reopen`, {}, opts); }
  /** listFileRequestUploads */
  uploads(id: string, params: T.ListFileRequestUploadsParams = {}, opts?: RequestOptions) { return this._list<T.FileRequestUpload>(`/requests/${enc(id)}/uploads`, params as Query, opts); }
}

export class Signatures extends Resource {
  /** createSignatureRequest – upload a PDF (bytes, Blob or a Node path); returns a draft. */
  async create(pdf: BinaryInput, params: T.CreateSignatureRequestParams = {}, opts?: RequestOptions) {
    const raw = await rawBody(pdf, 'application/pdf');
    const name = params.name ?? raw.name;
    return this.client.request<T.CreateSignatureRequestResponse>({ method: 'POST', path: '/signatures', query: { name }, raw: { data: raw.data, contentType: 'application/pdf' } }, opts);
  }
  /** listSignatureRequests */
  list(params: T.ListSignatureRequestsParams = {}, opts?: RequestOptions) { return this._list<T.SignatureRequest>('/signatures', params as Query, opts); }
  /** getSignatureRequest */
  retrieve(id: string, opts?: RequestOptions) { return this._get<T.GetSignatureRequestResponse>(`/signatures/${enc(id)}`, undefined, opts); }
  /** updateSignatureRequest – change the draft (title, message, signers, fields). */
  update(id: string, body: T.UpdateSignatureRequestBody, opts?: RequestOptions) { return this._patch<T.UpdateSignatureRequestResponse>(`/signatures/${enc(id)}`, body, opts); }
  /** sendSignatureRequest – optionally with final changes. */
  send(id: string, body: T.SendSignatureRequestBody = {}, opts?: RequestOptions) { return this._post<T.SendSignatureRequestResponse>(`/signatures/${enc(id)}/send`, body, opts); }
  /** remindSigners */
  remind(id: string, opts?: RequestOptions) { return this._post<T.RemindSignersResponse>(`/signatures/${enc(id)}/remind`, {}, opts); }
  /** cancelSignatureRequest */
  cancel(id: string, opts?: RequestOptions) { return this._post<T.CancelSignatureRequestResponse>(`/signatures/${enc(id)}/cancel`, {}, opts); }
  /** deleteSignatureRequest */
  delete(id: string, opts?: RequestOptions) { return this._del<T.DeleteSignatureRequestResponse>(`/signatures/${enc(id)}`, opts); }
  /** downloadSignatureOriginal – the uploaded PDF. */
  downloadOriginal(id: string, opts?: RequestOptions) { return this.client.request<Uint8Array>({ method: 'GET', path: `/signatures/${enc(id)}/document.pdf`, binary: true }, opts); }
  /** downloadSignedPdf – the signed PDF with its audit trail. */
  downloadSigned(id: string, opts?: RequestOptions) { return this.client.request<Uint8Array>({ method: 'GET', path: `/signatures/${enc(id)}/signed.pdf`, binary: true }, opts); }
}

export class BrandingResource extends Resource {
  /** getBranding */
  retrieve(opts?: RequestOptions) { return this._get<T.GetBrandingResponse>('/branding', undefined, opts); }
  /** updateBranding – name and colour. */
  update(body: T.UpdateBrandingBody, opts?: RequestOptions) { return this._patch<T.UpdateBrandingResponse>('/branding', body, opts); }
  /** uploadBrandingLogo – PNG, JPEG or WebP. */
  async uploadLogo(image: BinaryInput, contentType?: string, opts?: RequestOptions) {
    const raw = await rawBody(image, contentType || 'application/octet-stream');
    return this.client.request<T.UploadBrandingLogoResponse>({ method: 'PUT', path: '/branding/logo', raw: { data: raw.data, contentType: contentType || raw.contentType } }, opts);
  }
  /** deleteBrandingLogo */
  deleteLogo(opts?: RequestOptions) { return this._del<T.DeleteBrandingLogoResponse>('/branding/logo', opts); }
  /** uploadBrandingBackground */
  async uploadBackground(image: BinaryInput, contentType?: string, opts?: RequestOptions) {
    const raw = await rawBody(image, contentType || 'application/octet-stream');
    return this.client.request<T.UploadBrandingBackgroundResponse>({ method: 'PUT', path: '/branding/background', raw: { data: raw.data, contentType: contentType || raw.contentType } }, opts);
  }
  /** deleteBrandingBackground */
  deleteBackground(opts?: RequestOptions) { return this._del<T.DeleteBrandingBackgroundResponse>('/branding/background', opts); }
}

export class TeamResource extends Resource {
  /** getTeam (owner) */
  retrieve(opts?: RequestOptions) { return this._get<T.GetTeamResponse>('/team', undefined, opts); }
  /** listTeamMembers */
  members(params: T.ListTeamMembersParams = {}, opts?: RequestOptions) { return this._list<T.TeamMember>('/team/members', params as Query, opts); }
  /** listTeamInvites */
  invites(params: T.ListTeamInvitesParams = {}, opts?: RequestOptions) { return this._list<T.TeamInvite>('/team/invites', params as Query, opts); }
  /** createTeamInvites – 1–10 addresses. */
  invite(emails: string[], opts?: RequestOptions) { return this._post<T.CreateTeamInvitesResponse>('/team/invites', { emails }, opts); }
  /** revokeTeamInvite */
  revokeInvite(id: number | string, opts?: RequestOptions) { return this._del<T.RevokeTeamInviteResponse>(`/team/invites/${enc(String(id))}`, opts); }
}

export class Events extends Resource {
  /** listEvents – the last 30 days, newest first. since: ISO time, unix seconds or an event id. */
  list(params: T.ListEventsParams = {}, opts?: RequestOptions) { return this._list<T.Event>('/events', params as Query, opts); }
}

export class Hooks extends Resource {
  /** listHooks – REST hook subscriptions made with API keys. */
  list(params: T.ListHooksParams = {}, opts?: RequestOptions) { return this._list<T.Hook>('/hooks', params as Query, opts); }
  /** createHook – the response's secret (whsec_…) is shown once. */
  create(body: T.CreateHookBody, opts?: RequestOptions) { return this._post<T.CreateHookResponse>('/hooks', body, opts); }
  /** getHook */
  retrieve(id: number | string, opts?: RequestOptions) { return this._get<T.GetHookResponse>(`/hooks/${enc(String(id))}`, undefined, opts); }
  /** deleteHook */
  delete(id: number | string, opts?: RequestOptions) { return this._del<T.DeleteHookResponse>(`/hooks/${enc(String(id))}`, opts); }
}
