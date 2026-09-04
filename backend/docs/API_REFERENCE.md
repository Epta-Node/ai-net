# AI-Net API Reference

## Standard Error Schema

All API endpoints return errors in a consistent JSON format when a request fails.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query parameters",
    "path": "/api/tasks",
    "correlationId": "req-12345",
    "timestamp": "2023-10-25T14:45:00.000Z",
    "details": {
      "issues": {
        "formErrors": [],
        "fieldErrors": {
          "status": ["Invalid enum value. Expected 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'"]
        }
      }
    }
  }
}
```

### Properties

- `code` *(string)*: A machine-readable string indicating the category of the error.
- `message` *(string)*: A human-readable description of what went wrong.
- `path` *(string)*: The request path that triggered the error.
- `correlationId` *(string)*: A unique identifier for the request trace. Provide this when reporting issues.
- `timestamp` *(string)*: ISO-8601 timestamp of when the error occurred.
- `details` *(object, optional)*: Additional structured information (e.g., validation issues or current status). May be omitted in production environments for internal errors.

---

## Canonical Error Codes

The API will respond with one of the following canonical error codes.

### `VALIDATION_ERROR` (HTTP 400)
Indicates that the request payload, query parameters, or URL parameters failed validation (e.g., missing required fields, invalid types, or exceeding length limits).
*Example:* Missing a required prompt when submitting a task.

### `UNAUTHORIZED` (HTTP 401)
Indicates that the request requires authentication, but none was provided or the provided credentials (e.g., signature) were invalid.
*Example:* Missing or invalid `walletpublickey` signature.

### `PAYMENT_ERROR` (HTTP 402)
Indicates that a Stellar payment operation failed, usually due to insufficient balance or network issues.
*Example:* Insufficient XLM balance to fund a task budget.

### `FORBIDDEN` (HTTP 403)
Indicates that the authenticated user does not have permission to perform the requested action on the resource.
*Example:* Attempting to cancel or view a task owned by a different wallet.

### `NOT_FOUND` (HTTP 404)
Indicates that the requested resource does not exist.
*Example:* Fetching a task by an ID that hasn't been created.

### `CONFLICT` (HTTP 409)
Indicates a state conflict that prevents the action from being completed.
*Example:* Attempting to cancel a task that is already in a `running` or `completed` state.

### `RATE_LIMITED` (HTTP 429)
Indicates that the client has exceeded their allowed quota for requests. The response will include a `Retry-After` header indicating when to try again (in seconds).
*Example:* Exceeding the daily task submission limit (e.g., 100 per day) or hitting the global IP limit.

### `INTERNAL_ERROR` (HTTP 500)
Indicates an unexpected error occurred on the server. The internals of the error are masked in production to prevent leaking sensitive information.

### `UPSTREAM_UNAVAILABLE` (HTTP 502)
Indicates that the server received an invalid response or timeout from an upstream service it relies on.

### `VENICE_UNAVAILABLE` (HTTP 503)
Indicates that the Venice AI service is currently down or the circuit breaker has tripped due to consecutive failures.

### `STELLAR_UNAVAILABLE` (HTTP 503)
Indicates that the Stellar network (e.g., Horizon API) is currently unreachable or experiencing issues.
