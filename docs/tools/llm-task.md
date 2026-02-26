---
summary: "JSON-only LLM tasks for workflows (optional plugin tool)"
read_when:
  - You want a JSON-only LLM step inside workflows
  - You need schema-validated LLM output for automation
title: "LLM Task"
---

# LLM Task

`llm-task` is an **optional plugin tool** that runs a JSON-only LLM task and
returns structured output (optionally validated against JSON Schema).

This is ideal for workflow engines like Lobster: you can add a single LLM step
without writing custom OpenClaw code for each workflow.

## Enable the plugin

1. Enable the plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Allowlist the tool (it is registered with `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## Config (optional)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` is an allowlist of `provider/model` strings. If set, any request
outside the list is rejected.

## Tool parameters

- `prompt` (string, required)
- `input` (any, optional)
- `schema` (object, optional JSON Schema)
- `provider` (string, optional)
- `model` (string, optional)
- `authProfileId` (string, optional)
- `temperature` (number, optional)
- `maxTokens` (number, optional)
- `timeoutMs` (number, optional)

## Output

Returns `details.json` containing the parsed JSON (and validates against
`schema` when provided).

## Examples

### Direct HTTP invocation (recommended)

Invoke the tool directly via the OpenClaw Gateway's `/tools/invoke` endpoint without requiring an agent turn:

```bash
curl -X POST http://localhost:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{
    "tool": "llm-task",
    "action": "json",
    "sessionKey": "main",
    "args": {
      "prompt": "Given the input email, return intent and draft.",
      "input": {
        "subject": "Hello",
        "body": "Can you help?"
      },
      "schema": {
        "type": "object",
        "properties": {
          "intent": { "type": "string" },
          "draft": { "type": "string" }
        },
        "required": ["intent", "draft"],
        "additionalProperties": false
      }
    }
  }'
```

**Response:**
```json
{
  "ok": true,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\n  \"intent\": \"request_assistance\",\n  \"draft\": \"...\"\n}"
      }
    ],
    "details": {
      "json": {
        "intent": "request_assistance",
        "draft": "..."
      },
      "provider": "openai-codex",
      "model": "gpt-4"
    }
  }
}
```

#### Classification task

```bash
curl -X POST http://localhost:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{
    "tool": "llm-task",
    "action": "json",
    "sessionKey": "main",
    "args": {
      "prompt": "Classify this support ticket into one of: bug, feature_request, question, or complaint",
      "input": {
        "subject": "Login fails",
        "body": "I cannot log into the app"
      },
      "schema": {
        "type": "object",
        "properties": {
          "category": {
            "type": "string",
            "enum": ["bug", "feature_request", "question", "complaint"]
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          }
        },
        "required": ["category", "confidence"]
      }
    }
  }'
```

#### Extract structured data

```bash
curl -X POST http://localhost:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{
    "tool": "llm-task",
    "action": "json",
    "sessionKey": "main",
    "args": {
      "prompt": "Extract contact information from this email signature",
      "input": {
        "signature": "John Doe\\nSenior Engineer\\njohn@example.com\\n+1-555-0123"
      },
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "title": { "type": "string" },
          "email": { "type": "string" },
          "phone": { "type": "string" }
        }
      }
    }
  }'
```

#### Override provider and model

```bash
curl -X POST http://localhost:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{
    "tool": "llm-task",
    "action": "json",
    "sessionKey": "main",
    "args": {
      "prompt": "Summarize this article in 2-3 sentences",
      "input": { "text": "Long article text here..." },
      "provider": "anthropic",
      "model": "claude-opus-4",
      "maxTokens": 200
    }
  }'
```

**Notes:**
- Replace `YOUR_GATEWAY_TOKEN` with your actual gateway token (configured via `gateway.auth.token` or env var `OPENCLAW_GATEWAY_TOKEN`)
- Replace `http://localhost:18789` with your gateway address if different
- The `sessionKey` determines which agent configuration to use (defaults to `"main"`)
- Set `"dryRun": true` in the request body to validate without executing

### From Lobster workflows

Invoke from a Lobster pipeline using `openclaw.invoke`:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## Common patterns

### Classification workflows

Use llm-task to categorize content before routing or processing:

**HTTP:**
```bash
curl -X POST http://localhost:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{
    "tool": "llm-task",
    "action": "json",
    "sessionKey": "main",
    "args": {
      "prompt": "Classify this support ticket into one of: bug, feature_request, question, or complaint",
      "input": {"subject": "Login fails", "body": "I cannot log into the app"},
      "schema": {
        "type": "object",
        "properties": {
          "category": {"type": "string", "enum": ["bug", "feature_request", "question", "complaint"]},
          "confidence": {"type": "number", "minimum": 0, "maximum": 1}
        },
        "required": ["category", "confidence"]
      }
    }
  }'
```

**Lobster:**
```lobster
# Classify support tickets and route based on category
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Classify this support ticket into one of: bug, feature_request, question, or complaint",
  "input": {"subject": "Login fails", "body": "I cannot log into the app"},
  "schema": {
    "type": "object",
    "properties": {
      "category": {"type": "string", "enum": ["bug", "feature_request", "question", "complaint"]},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1}
    },
    "required": ["category", "confidence"]
  }
}'
```

### Data extraction

Extract structured data from unstructured text:

**HTTP:**
```bash
curl -X POST http://localhost:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{
    "tool": "llm-task",
    "action": "json",
    "sessionKey": "main",
    "args": {
      "prompt": "Extract contact information from this email signature",
      "input": {"signature": "John Doe\\nSenior Engineer\\njohn@example.com\\n+1-555-0123"},
      "schema": {
        "type": "object",
        "properties": {
          "name": {"type": "string"},
          "title": {"type": "string"},
          "email": {"type": "string"},
          "phone": {"type": "string"}
        }
      }
    }
  }'
```

**Lobster:**
```lobster
# Extract contact info from email signature
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Extract contact information from this email signature",
  "input": {"signature": "John Doe\\nSenior Engineer\\njohn@example.com\\n+1-555-0123"},
  "schema": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "title": {"type": "string"},
      "email": {"type": "string"},
      "phone": {"type": "string"}
    }
  }
}'
```

### Content transformation

Transform content from one format to another:

**HTTP:**
```bash
curl -X POST http://localhost:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{
    "tool": "llm-task",
    "action": "json",
    "sessionKey": "main",
    "args": {
      "prompt": "Convert these meeting notes into a list of action items with owner and deadline",
      "input": {"notes": "Alice to review PR by Friday. Bob will update docs next week."},
      "schema": {
        "type": "object",
        "properties": {
          "actionItems": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "task": {"type": "string"},
                "owner": {"type": "string"},
                "deadline": {"type": "string"}
              },
              "required": ["task", "owner"]
            }
          }
        },
        "required": ["actionItems"]
      }
    }
  }'
```

**Lobster:**
```lobster
# Convert meeting notes to action items
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Convert these meeting notes into a list of action items with owner and deadline",
  "input": {"notes": "Alice to review PR by Friday. Bob will update docs next week."},
  "schema": {
    "type": "object",
    "properties": {
      "actionItems": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "task": {"type": "string"},
            "owner": {"type": "string"},
            "deadline": {"type": "string"}
          },
          "required": ["task", "owner"]
        }
      }
    },
    "required": ["actionItems"]
  }
}'
```

## Safety notes

- The tool is **JSON-only** and instructs the model to output only JSON (no
  code fences, no commentary).
- No tools are exposed to the model for this run.
- Treat output as untrusted unless you validate with `schema`.
- Put approvals before any side-effecting step (send, post, exec).
