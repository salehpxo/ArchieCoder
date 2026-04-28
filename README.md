<p align="center">
  <img src="https://img.shields.io/badge/status-beta-blue?style=flat-square" alt="Status: Beta">
  <img src="https://img.shields.io/badge/version-1.0.0-blue?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-ISC-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 18">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
</p>

<h1 align="center">⚡ archiecoder</h1>

<p align="center">
  <em>A minimal, terminal-native AI coding assistant — like Claude Code, but your stack, your API, your rules.</em>
</p>

<br/>

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔌 | **Any API** | OpenAI, OpenRouter, Anthropic, Ollama — any OpenAI-compatible or Ollama-native endpoint |
| 🛠️ | **7 Built-in Tools** | `read` · `write` · `edit` · `glob` · `grep` · `bash` · `ollama_code` |
| 🧠 | **Ollama Subagent** | Offload code generation to a local Ollama model via the `ollama_code` tool |
| 🎨 | **Beautiful Terminal UI** | ANSI colors, markdown rendering, live tool output streaming |
| 📁 | **@-File Mentions** | Type `@` to autocomplete project file paths — instant context injection |
| 📝 | **Multi-line Input** | Full keybindings: arrows, home/end, shift+enter for newlines |
| 🔧 | **Zero Config** | Drop a `.env` file with your `API_KEY` and go |
| 🧹 | **Smart Ignore** | Auto-skips `node_modules`, `.git`, binaries, lockfiles, and more |

---

## 🚀 Quick Start

```bash
# Clone & install
git clone <repo-url> && cd archiecoder
pnpm install

# Configure your API key
echo "API_KEY=sk-..." > .env

# Run
pnpm dev
```

That's it. You're talking to an AI coding assistant in your terminal.

---

## ⚙️ Configuration

archiecoder reads from a `.env` file (or environment variables):

| Variable | Default | Required | Description |
|---|---|---|---|
| `API_KEY` | — | ✅ | Your API key (OpenRouter, OpenAI, etc.) |
| `API_URL` | `https://openrouter.ai/api/v1/chat/completions` | | Chat completions endpoint |
| `MODEL` | `deepseek-v4-flash` | | Model name to use |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | | Ollama server URL (only used with Ollama endpoints) |
| `OLLAMA_MODEL` | `qwen3.5:0.8b` | | Model for the `ollama_code` subagent |

**Example `.env`:**

```
API_KEY=sk-or-v1-your-openrouter-key
API_URL=https://openrouter.ai/api/v1/chat/completions
MODEL=anthropic/claude-sonnet-20241022
```

Or for **Ollama**:

```
API_URL=http://localhost:11434/api/chat
OLLAMA_MODEL=llama3.2:3b
```

---

## 🎮 Usage

```bash
pnpm dev          # Run in development mode (tsx watch)
pnpm start        # Run compiled JS from dist/
pnpm build        # Compile TypeScript
```

### Commands

| Command | Action |
|---|---|
| `/q` or `exit` | Quit the assistant |
| `/c` | Clear conversation history |
| `@<filepath>` | Mention a file to attach its contents as context |

### Keybindings (input mode)

| Key | Action |
|---|---|
| `Enter` | Submit message |
| `Shift+Enter` | New line |
| `↑` / `↓` | Navigate lines / mention suggestions |
| `←` / `→` | Move cursor |
| `Home` / `End` | Jump to start / end of line |
| `Esc` | Close file mention picker |
| `Tab` / `Enter` (in picker) | Accept file suggestion |
| `Ctrl+C` | Exit |
| `Ctrl+D` | Send empty / exit |

---

## 🛠️ Tools Reference

archiecoder equips the AI with these tools to interact with your codebase:

| Tool | Description | Parameters |
|---|---|---|
| `read` | Read a file with line numbers | `path`, `offset?`, `limit?` |
| `write` | Write content to a file | `path`, `content` |
| `edit` | Replace text in a file (unique match or `all=true`) | `path`, `old`, `new`, `all?` |
| `glob` | Find files by glob pattern (sorted by mtime) | `pat`, `path?` |
| `grep` | Search file contents by regex (max 50 results) | `pat`, `path?` |
| `bash` | Run a shell command (30s timeout, live output) | `cmd` |
| `ollama_code` | Subagent: delegate code gen to a local Ollama model | `instruction`, `file_context?`, `file_path?` |

Each tool result is shown inline with a preview, so you stay in the flow.

---

## 📁 File Mentions (`@`)

Type `@` while typing to trigger the **file picker**:

```
❯ Refactor the database layer in @src/db
```

- As you type after `@`, archiecoder filters project files (fuzzy matching)
- `↑`/`↓` to navigate suggestions, `Enter` or `Tab` to select
- Press `Esc` to close the picker
- Selected files are read and attached as context to the AI

This makes it effortless to reference existing code without copy-pasting.

---

## 🧠 Ollama Subagent

The `ollama_code` tool lets the main AI delegate concrete coding tasks to a **local Ollama model**. This is useful for:

- Writing boilerplate code
- Refactoring small functions
- Generating test cases
- Performing quick edits without consuming API tokens

Configure it via `OLLAMA_BASE_URL` and `OLLAMA_MODEL` in your `.env`.

---

## 📂 Project Structure

```
archiecoder/
├── src/
│   └── index.ts          # ~1400 lines, zero-dependency runtime
├── dist/                 # Compiled output (tsc)
├── .env                  # Your API configuration (gitignored)
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── README.md
```

> **Zero runtime dependencies.** The only packages are dev-only: `typescript`, `tsx`, and `@types/node`.

---

## 🧰 Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict, ESM) |
| Runtime | Node.js ≥ 18 (built-in `fetch`) |
| Package Manager | pnpm |
| Build | `tsc` + `tsx` for dev |
| API Protocols | OpenAI-compatible `/v1/chat/completions` + Ollama `/api/chat` |
| Terminal UI | Raw ANSI escape codes (no lib) |

---

## 📄 License

ISC — do what you want.

---

<p align="center">
  <sub>Built with ❤️ for developers who prefer their AI assistant in a terminal.</sub>
</p>
