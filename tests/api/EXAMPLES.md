# Example Requests (curl)

Below are example `curl` commands demonstrating all endpoints exposed by `personal-antigravity-api`.

## 1. Health Check (`GET /health`)
Lightweight health endpoint (no auth required):

```bash
curl -i http://localhost:3000/health
```

Example Response:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 42,
  "timestamp": "2026-10-17T07:45:00.000Z",
  "provider": {
    "mode": "antigravity"
  }
}
```

## 2. Model Listing (`GET /v1/models`)
Lists available models in standard OpenAI format:

```bash
curl -i http://localhost:3000/v1/models \
  -H "Authorization: Bearer dev-local-key"
```

Example Response:
```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-3.8-flash-high",
      "object": "model",
      "created": 1700000000,
      "owned_by": "personal-antigravity"
    }
  ]
}
```

## 3. Non-Streaming Chat Completion (`POST /v1/chat/completions`)
Standard OpenAI non-streaming chat request:

```bash
curl -i http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer dev-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash-high",
    "messages": [
      { "role": "system", "content": "You are a concise assistant." },
      { "role": "user", "content": "Hello!" }
    ],
    "temperature": 0.7
  }'
```

Example Response:
```json
{
  "id": "chatcmpl-0123456789abcdef0123456789abcdef",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "gemini-3.8-flash-high",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I assist you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25
  }
}
```

## 4. Streaming Chat Completion (`POST /v1/chat/completions` with SSE)
OpenAI Server-Sent Events (SSE) stream using `-N` / `--no-buffer`:

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer dev-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash-high",
    "messages": [
      { "role": "user", "content": "Tell me a short joke." }
    ],
    "stream": true,
    "stream_options": {
      "include_usage": true
    }
  }'
```

Example Stream output:
```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.8-flash-high","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.8-flash-high","choices":[{"index":0,"delta":{"content":"Why do programmers "},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.8-flash-high","choices":[{"index":0,"delta":{"content":"prefer dark mode?"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.8-flash-high","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.8-flash-high","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}

data: [DONE]
```

## 5. Usage Metrics (`GET /usage`)
In-memory accumulated token and request metrics:

```bash
curl -i http://localhost:3000/usage \
  -H "Authorization: Bearer dev-local-key"
```

Example Response:
```json
{
  "object": "usage",
  "data": {
    "requests": 2,
    "prompt_tokens": 27,
    "completion_tokens": 18,
    "total_tokens": 45,
    "by_model": {
      "gemini-3.8-flash-high": {
        "requests": 2,
        "prompt_tokens": 27,
        "completion_tokens": 18,
        "total_tokens": 45
      }
    },
    "since": 1700000000000,
    "provider": {
      "promptTokens": 100,
      "completionTokens": 200,
      "totalTokens": 300
    }
  }
}
```
