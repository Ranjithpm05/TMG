import { Injectable, computed, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class LoadingService {
  private count = signal(0);
  isLoading = computed(() => this.count() > 0);

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.count.update(n => n + 1);
    try {
      return await fn();
    } finally {
      this.count.update(n => Math.max(0, n - 1));
    }
  }
}
