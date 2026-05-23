# API Contract — Claude Agent Endpoints

This document describes the backend API endpoints used to generate and execute test-cases via a Claude agent, and the data shapes exchanged.

---

## POST /api/test-cases/generate

- Purpose: Request the Claude agent to generate test cases for a project and a list of requirements.
- Auth: httpOnly cookie token required (server validates session/identity).
- Vault: server reads `claudeApiKey` from vault using a per-user key `vault[userId_claudeApiKey]`.

Request body:
```json
{ "projectId": "string", "requirementIds": ["string"] }
```

Response (success):
```json
{ "success": true, "data": [ /* TestCase[] */ ] }
```

Response (error):
```json
{ "success": false, "message": "string" }
```

TestCase shape:
```json
{
  "id": "string",           // e.g. "tc-{uuid}"
  "name": "string",
  "type": "functional"|"smoke"|"regression"|"security"|"boundary",
  "module": "string",
  "confidence": 70-99,
  "status": "pending",
  "assertions": "string"
}
```

Notes:
- The server should validate `projectId` and `requirementIds` before calling Claude.
- Claude responses must be sanitized and normalized to the `TestCase` shape before returning to client.

---

## POST /api/test-cases/execute

- Purpose: Start execution of a set of test-cases for a project. This is an asynchronous operation.

Request body:
```json
{ "projectId": "string", "testCaseIds": ["string"] }
```

Response (immediate acknowledgement):
```json
{ "success": true, "runId": "string", "message": "Execution started" }
```

Execution updates are streamed to clients via WebSocket (or server-sent events). WebSocket messages follow shape:
```json
{ "type": "log"|"result"|"complete", /* other fields depending on type */ }
```

- `log`: textual logs emitted during execution.
- `result`: individual test result updates (see `ExecutionResult` shape below).
- `complete`: indicates run completion.

---

## GET /api/runs/:runId/results

- Purpose: Retrieve final results for a completed run.

Response (success):
```json
{ "success": true, "results": { "<tcId>": /* ExecutionResult */ } }
```

---

## ExecutionResult shape

Returned per-test in results and in streaming `result` messages:
```json
{
  "status": "pass"|"fail"|"blocked",
  "time": "string",                 // human-friendly duration or timestamp
  "error": "string",                // error message when status === 'fail'
  "screenshots": ["string"],        // array of artifact filenames/urls
  "video": "string",                // filename/url or null
  "trace": ["string"],              // ordered list of steps
  "networkSummary": "string",       // short summary of network activity
  "dataCreated": { "id": "string", "name": "string" } | null
}
```

---

## Notes for implementers

- Use secure server-side vaults for Claude API keys. Never expose keys to the client.
- Use an authenticated cookie-based session. The endpoints assume a server-side `userId` is available to resolve vault keys.
- For `execute`, provide a `runId` immediately and stream progress via WebSocket. Clients may poll `GET /api/runs/:runId/results` if streaming is unavailable.
- Make sure to normalize timestamps and durations consistently (ISO 8601 for timestamps, humanized durations for `time`).

---

End of contract.
