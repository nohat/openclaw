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
          "allowedModels": ["openai-codex/gpt-5.2"],
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

### From the command line via agent

You can also invoke the tool by asking the agent to use it:

#### Basic classification task

```bash
openclaw agent --message "Use llm-task to classify this email as urgent or normal: 'Server is down!'"
```

#### Structured output with schema

```bash
openclaw agent --message "Use llm-task to analyze this customer feedback and return a JSON object with sentiment (positive/negative/neutral) and priority (high/medium/low) fields: 'Your product is amazing but shipping was slow.'"
```

#### Summarization task

```bash
openclaw agent --message "Use llm-task to summarize this text into 2-3 sentences: 'Long article text here...'"
```

### Direct invocation (via agent session)

When the agent has access to the `llm-task` tool, you can ask it to invoke the tool directly. The agent will construct the appropriate tool call with schema validation.

#### Email intent detection

```bash
openclaw agent --message "Call llm-task to detect intent from this email: subject 'Meeting Request', body 'Can we meet tomorrow?'. Return JSON with intent and suggested_action fields."
```

#### Content classification

```bash
openclaw agent --message "Use llm-task to classify this support ticket into category (bug/feature/question) and urgency (high/medium/low): 'Login button not working on mobile app'"
```

#### Draft generation

```bash
openclaw agent --message "Use llm-task to draft a response to this customer inquiry. Input: 'When will the new feature be available?' Return JSON with draft and tone fields."
```

### Using custom provider and model

Override the default provider/model:

```bash
openclaw agent --message "Use llm-task with provider 'anthropic' and model 'claude-opus-4' to analyze this code review comment and suggest improvements"
```

### Working with JSON schema validation

Request strict schema validation:

```bash
openclaw agent --message "Use llm-task to extract meeting details from this text: 'Team standup tomorrow at 10am in room 305'. The output MUST match this schema: {type: object, properties: {date: {type: string}, time: {type: string}, location: {type: string}}, required: [date, time, location]}"
```

## Common patterns

### Classification workflows

Use llm-task to categorize content before routing or processing:

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
