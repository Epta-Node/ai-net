import { CircuitOpenError } from './errors.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 60_000;

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  getState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  getFailureCount(): number {
    return this.failures;
  }

  assertClosed(): void {
    this.evaluateState();
    if (this.state === 'OPEN') {
      throw new CircuitOpenError();
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= FAILURE_THRESHOLD) {
      this.state = 'OPEN';
      this.openedAt = this.nowFn();
    }
  }

  private evaluateState(): void {
    if (this.state === 'OPEN') {
      const elapsed = this.nowFn() - this.openedAt;
      if (elapsed >= OPEN_DURATION_MS) {
        this.state = 'HALF_OPEN';
      }
    }
  }
}
