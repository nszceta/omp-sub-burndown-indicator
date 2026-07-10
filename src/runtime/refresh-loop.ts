export interface RefreshLoopOptions {
  intervalMs: number;
  run(signal: AbortSignal): Promise<void>;
  onError?(error: unknown): void;
}

export class RefreshLoop {
  readonly #options: RefreshLoopOptions;
  #controller: AbortController | undefined;
  #timer: Timer | undefined;
  #running: Promise<void> | undefined;

  constructor(options: RefreshLoopOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return this.#controller !== undefined;
  }

  start(): Promise<void> {
    if (this.#controller) return this.#running ?? Promise.resolve();
    this.#controller = new AbortController();
    return this.trigger();
  }

  trigger(): Promise<void> {
    if (!this.#controller) return Promise.resolve();
    if (this.#running) return this.#running;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const controller = this.#controller;
    const running = this.#options
      .run(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.#options.onError?.(error);
      })
      .finally(() => {
        if (this.#running === running) this.#running = undefined;
        if (this.#controller !== controller || controller.signal.aborted) return;
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          void this.trigger();
        }, this.#options.intervalMs);
      });
    this.#running = running;
    return running;
  }

  stop(reason: unknown = new DOMException("Session ended", "AbortError")): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort(reason);
    this.#controller = undefined;
  }
}
