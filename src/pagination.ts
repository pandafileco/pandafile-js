import type { ListResponse } from './generated/types.js';

export type FetchPage<T> = (startingAfter: string | undefined) => Promise<ListResponse<T>>;

/** One page of a list, with a way to the next. */
export class Page<T> implements ListResponse<T> {
  readonly object = 'list' as const;
  readonly data: T[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;

  constructor(private readonly fetchPage: FetchPage<T>, res: ListResponse<T>) {
    this.data = Array.isArray(res?.data) ? res.data : [];
    this.has_more = !!res?.has_more;
    this.next_cursor = res?.next_cursor ?? null;
  }

  hasNextPage(): boolean { return this.has_more && !!this.next_cursor; }

  async nextPage(): Promise<Page<T> | null> {
    if (!this.hasNextPage()) return null;
    return new Page(this.fetchPage, await this.fetchPage(this.next_cursor!));
  }
}

/**
 * What every list method returns. `await` it for the first page, or iterate it to walk every item across pages:
 *
 *   const page = await pf.transfers.list({ limit: 50 });
 *   for await (const t of pf.transfers.list()) console.log(t.id);
 */
export class PageRequest<T> implements PromiseLike<Page<T>>, AsyncIterable<T> {
  private first: Promise<Page<T>> | null = null;

  constructor(private readonly fetchPage: FetchPage<T>, private readonly startingAfter?: string) {}

  private load(): Promise<Page<T>> {
    this.first ||= this.fetchPage(this.startingAfter).then((r) => new Page(this.fetchPage, r));
    return this.first;
  }

  then<A = Page<T>, B = never>(onfulfilled?: ((v: Page<T>) => A | PromiseLike<A>) | null, onrejected?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.load().then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<Page<T> | B> {
    return this.load().catch(onrejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: Page<T> | null = await this.load();
    while (page) {
      for (const item of page.data) yield item;
      page = await page.nextPage();
    }
  }

  /** Every item across pages (stops after `max` items when given). */
  async toArray(max = Infinity): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) {
      if (out.length >= max) break;
      out.push(item);
    }
    return out;
  }
}
