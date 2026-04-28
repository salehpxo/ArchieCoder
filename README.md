
<h1 align="center">
  <br>
  <pre>
   _                         _           _
  | |                       | |         | |
  | |__   ___ _ __  ___  ___| | ___  ___| |___
  | '_ \ / _ \ '_ \/ __|/ __| |/ _ \/ __| / __|
  | | | |  __/ | | \__ \ (__| | (_) \__ \ \__ \
  |_| |_|\___|_| |_|___/\___|_|\___/|___/_|___/
  </pre>
  <br>
  archiecoder
</h1>

<p align="center">
  <strong>A minimal Claude Code alternative — written in TypeScript</strong>
  <br>
  <sub>Agentic coding assistant for your terminal, powered by any OpenAI-compatible API or local Ollama models.</sub>
</p>

<p align="center">
  <code>pnpm dev</code> &nbsp;·&nbsp; <code>@mention</code> &nbsp;·&nbsp; <code>read</code> &nbsp;·&nbsp; <code>write</code> &nbsp;·&nbsp; <code>edit</code> &nbsp;·&nbsp; <code>glob</code> &nbsp;·&nbsp; <code>grep</code> &nbsp;·&nbsp; <code>bash</code> &nbsp;·&nbsp; <code>ollama_code</code>
</p>

---

## ✨ Features

| | |
|---|---|
| 🧠 **LLM-Agent Loop** | Multi-turn conversation with tool-calling — the LLM reads, writes, edits, searches, and runs commands autonomously. |
| 🎨 **Rich Terminal UI** | ANSI colors, markdown rendering, dimmed separators, and a live status line. |
| 🔍 **`@mention` File Picker** | Type `@` to fuzzy-find and attach any project file as context — works with arrow keys + Enter. |
| 🔧 **7 Built-in Tools** | `read`, `write`, `edit`, `glob`, `grep`, `bash`, and `ollama_code` (subagent for local code gen). |
| 🌐 **Multi-Provider** | Works with **OpenRouter**, **OpenAI**, **Anthropic**, **DeepSeek**, or **Ollama** — just swap the `API_URL`. |
| 🏠 **Local-First** | Auto-detects Ollama's native `/api/chat` endpoint and uses tool-calling natively. |
| 📎 **File Context** | `@`-mention any file in your project — its contents are attached into the prompt automatically. |
| 🧹 **Sensible Ignore** | Skips `node_modules`, `.git`, `dist`, binaries, lock files, images, and more automatically. |
| ⚡ **Single File** | Everything is in one self-contained `src/index.ts` — easy to read, hack, and extend. |

---

## 🧰 Prerequisites

- **Node.js** ≥ 18 (built-in `fetch`)
- **pnpm** (or npm / yarn — lockfile is `pnpm-lock.yaml`)
- **Ollama** *(optional)* — only if you want to run the `ollama_code` subagent or use a local model as the main LLM

---

## 📦 Installation

```bash
# Clone the repo
git clone <repo-url> archiecoder
cd archiecoder

# Install dependencies
pnpm install

# (Optional) Create a .env file
echo 'API_KEY=your-api-key-here' > .env
echo 'API_URL=https://openrouter.ai/api/v1/chat/completions' >> .env
echo 'MODEL=deepseek-v4-flash' >> .env
```

---

## 🚀 Usage

### Run in development mode

```bash
pnpm dev
```

### Build & run in production

```bash
pnpm build
pnpm start
```

### Interactive Commands

| Command | Action |
|---------|--------|
| `/q` or `exit` | Quit the program |
| `/c` | Clear the conversation history |

### `@mention` Files

While typing, use `@` followed by a file path to attach its content as context:

```
> fix the bug in @src/index.ts
```

Press **Tab** or **Enter** to accept a suggestion, **↑/↓** to navigate, **Esc** to close the picker.

---

## 🔧 Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_KEY` | ✅ **Yes** | — | API key for the remote provider (e.g., OpenRouter, OpenAI) |
| `API_URL` | ❌ No | `https://openrouter.ai/api/v1/chat/completions` | Chat completions endpoint (OpenAI-compatible or Ollama `/api/chat`) |
| `MODEL` | ❌ No | `deepseek-v4-flash` | Model name to use |
| `OLLAMA_BASE_URL` | ❌ No | `http://localhost:11434` | Base URL for local Ollama instance |
| `OLLAMA_MODEL` | ❌ No | `qwen3.5:0.8b` | Ollama model used by the `ollama_code` subagent |

> The tool reads a `.env` file in the project root if one exists — no dotenv dependency needed.

---

## 🛠️ Built-in Tools

Every tool is exposed to the LLM agent and can be invoked autonomously during a conversation.

| Tool | Description | Key Parameters |
|---|---|---|
| `read` | Read file with line numbers | `path` (required), `offset`, `limit` |
| `write` | Write content to a file | `path` (required), `content` (required) |
| `edit` | Replace text in a file | `path` (required), `old` (required), `new` (required), `all` |
| `glob` | Find files by pattern (sorted by mtime) | `pat` (required), `path` |
| `grep` | Search files by regex pattern | `pat` (required), `path` |
| `bash` | Run a shell command (30s timeout) | `cmd` (required) |
| `ollama_code` | Subagent — delegates code gen to local Ollama | `instruction` (required), `file_path` (required), `file_context` |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────┐
│                    Main Loop                      │
│                                                  │
│   ┌────────┐    ┌──────────┐    ┌─────────────┐ │
│   │  ask()  │───▶│ callApi() │───▶│  runTool() │ │
│   │ (input) │    │ (LLM)    │    │ (execution) │ │
│   └────────┘    └──────────┘    └──────┬──────┘ │
│                                        │        │
│                              ┌─────────▼──────┐ │
│                              │  Tool Registry │ │
│                              │ read · write   │ │
│                              │ edit · glob    │ │
│                              │ grep · bash    │ │
│                              │ ollama_code    │ │
│                              └────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Single file, modular internals:**

| Section | Lines | Purpose |
|---|---|---|
| ANSI Styling | ~25 | Terminal color constants |
| Config & Env | ~30 | Load `.env`, set defaults |
| Ollama Detection | ~15 | Auto-detect `/api/chat` endpoint |
| Glob / Walk / Ignore | ~120 | File system helpers with smart ignore lists |
| Tool Implementations | ~230 | All 7 tool functions |
| API Call | ~180 | Provider abstraction (OpenAI / Ollama) |
| Input Editor (`ask()`) | ~330 | Multi-line terminal with `@mention` file picker |
| Main Loop | ~100 | Conversation orchestration |

---

## 🔄 How It Works

1. **You type** a prompt (optionally `@mention`-ing files for context).
2. **The LLM responds** — either with text or by requesting a tool call.
3. **If a tool call** is requested, the tool runs locally and the result is fed back to the LLM.
4. **The LLM continues** looping until it produces a final text response.
5. **You see** the response rendered with markdown formatting in your terminal.

This agent loop means the LLM can autonomously read your codebase, search for patterns, write new files, edit existing ones, run shell commands, and even delegate sub-tasks to a local Ollama model — all within a single conversation turn.

---

## 📁 Project Structure

```
archiecoder/
├── src/
│   └── index.ts          # The entire application (single file)
├── .env                  # Environment variables (optional)
├── .gitignore
├── package.json          # Dependencies & scripts
├── pnpm-lock.yaml
├── tsconfig.json         # TypeScript configuration
└── README.md             # This file
```

---

## 🧪 Demo

```
┌──────────────────────────────────────────────────────────┐
│  archiecoder | deepseek-v4-flash | /Users/me/project       │
│                                                          │
│  ──────────────────────────────────────────────────────── │
│  ❯ add a helper function to parse CSV in @src/index.ts   │
│  ──────────────────────────────────────────────────────── │
│                                                          │
│  ⏺ Read(src/index.ts)                                    │
│    ⎿   1| #!/usr/bin/env -S npx tsx ...                  │
│                                                          │
│  ⏺ Let me look at the current file structure first.      │
│                                                          │
│  ⏺ I'll add a parseCSV function at the bottom...         │
│                                                          │
│  ⏺ OllamaCode(instruction=..., file_path=src/index.ts)   │
│    ⎿ ok: wrote 12 lines to src/index.ts                  │
│                                                          │
│  ── ollama_code output ──                                 │
│  ok: wrote 12 lines to src/index.ts                      │
│  ── end of output ──                                      │
│                                                          │
│  ⏺ ✅ Done! Added a parseCSV() utility at the end of     │
│     src/index.ts. It uses Papa Parse-style logic with     │
│     quote escaping and header extraction.                 │
└──────────────────────────────────────────────────────────┘
```

---

## 📄 License

**ISC** — see [package.json](./package.json).

---

<p align="center">
  Built with ❤️ using TypeScript
  <br>
  <sub>zero bloat, maximum power.</sub>
</p>
