export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is OPEN — Venice requests are blocked') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class TokenBudgetExceededError extends Error {
  constructor(requested: number, cap: number) {
    super(`Token budget exceeded: requested ${requested}, hard cap is ${cap}`);
    this.name = 'TokenBudgetExceededError';
  }
}
