import { Signal, WritableSignal, computed, linkedSignal } from '@angular/core';

/**
 * Renders a long list in pages of `pageSize` rows ("Show more") instead of
 * all at once. The full-history lists (every Packing List, DC, Invoice, Sales
 * Order ever created) were rendering thousands of table rows on screen open,
 * which is most of those screens' time-to-interactive once the data is local.
 * Filtering/search still runs over the complete list; only the DOM is capped.
 * The limit resets whenever the source list changes (new filter/search/data).
 */
export class IncrementalList<T> {
  private readonly limit: WritableSignal<number>;
  readonly visible: Signal<T[]>;
  readonly remaining: Signal<number>;

  constructor(source: Signal<T[]>, private readonly pageSize = 100) {
    this.limit = linkedSignal({ source, computation: () => pageSize });
    this.visible = computed(() => source().slice(0, this.limit()));
    this.remaining = computed(() => Math.max(0, source().length - this.limit()));
  }

  showMore(): void {
    this.limit.update((n) => n + this.pageSize);
  }
}
