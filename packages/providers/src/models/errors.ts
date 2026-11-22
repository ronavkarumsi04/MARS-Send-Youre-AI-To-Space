import type { RoutingAttempt } from "@mars/contracts";

export interface ProviderErrorOptions {
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  /** The adapter's own request timeout fired; never set for caller aborts or HTTP errors. */
  timedOut?: boolean;
  definitelyNoGeneration?: boolean;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly providerId: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly timedOut: boolean;
  readonly definitelyNoGeneration: boolean;

  constructor(
    providerId: string,
    message: string,
    options: ProviderErrorOptions,
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.providerId = providerId;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.timedOut = options.timedOut ?? false;
    this.definitelyNoGeneration = options.definitelyNoGeneration ?? false;
  }
}

export interface SkippedModel {
  modelId: string;
  reason: string;
}

export class NoModelAvailableError extends Error {
  readonly skipped: SkippedModel[];
  readonly attempts: RoutingAttempt[];
  /** The last provider attempt ended in its request timeout. */
  readonly timedOut: boolean;
  readonly definitelyNoGeneration: boolean;

  constructor(
    skipped: SkippedModel[],
    attempts: RoutingAttempt[] = [],
    timedOut = false,
    definitelyNoGeneration = attempts.length === 0,
  ) {
    const details = skipped.length
      ? skipped.map(({ modelId, reason }) => `${modelId}: ${reason}`).join("; ")
      : "no candidates configured";
    super(`No model available (${details})`);
    this.name = "NoModelAvailableError";
    this.skipped = skipped;
    this.attempts = attempts;
    this.timedOut = timedOut;
    this.definitelyNoGeneration = definitelyNoGeneration;
  }
}
