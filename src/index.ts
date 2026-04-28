#!/usr/bin/env -S npx tsx
/**
 * nanocode.ts — minimal claude code alternative in TypeScript
 *
 * Requirements:
 *   Node.js >= 18 (built‑in fetch)
 *
 * Environment variables:
 *   API_KEY   – your API key (required)
 *   API_URL   – chat completions endpoint
 *               (default: https://openrouter.ai/api/v1/chat/completions)
 *   MODEL     – model name (default: deepseek-v4-flash)
 */

import * as fs from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------------------------
// ANSI styling
// ---------------------------------------------------------------------------
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

// ---------------------------------------------------------------------------
// Configuration (load from .env if it exists, then from environment)
// ---------------------------------------------------------------------------
if (existsSync(".env")) {
  const envContent = readFileSync(".env", "utf-8");
  for (const line of envContent.split("\n")) {
    const [key, ...val] = line.split("=");
    if (key && val.length > 0) {
      process.env[key.trim()] = val.join("=").trim();
    }
  }
}

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error(`${RED}Error: API_KEY environment variable is required${RESET}`);
  process.exit(1);
}

const API_URL =
  process.env.API_URL ??
  "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.MODEL ?? "deepseek-v4-flash";
const CWD = process.cwd();
const TERMINAL_WIDTH = process.stdout.columns ?? 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonArray = JsonValue[];

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

interface ContentBlockText {
  type: "text";
  text: string;
}

interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, JsonValue>;
}

interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type ContentBlock = ContentBlockText | ContentBlockToolUse;
type MessageContent = string | ContentBlock[] | ContentBlockToolResult[];

interface ApiResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
}

interface Message {
  role: "user" | "assistant";
  content: MessageContent;
  /** The complete, unmodified raw assistant message from the provider. */
  rawAssistantMessage?: Record<string, any>;
}

interface CallApiResult {
  response: ApiResponse;
  rawAssistantMessage?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Minimal glob matcher
// ---------------------------------------------------------------------------
function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i += 2;
        if (pattern[i] === "/" || pattern[i] === "\\") i++;
        continue;
      }
      regexStr += "[^/]*";
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (".+^$()[]{}|\\".includes(ch)) {
      regexStr += "\\" + ch;
    } else {
      regexStr += ch;
    }
    i++;
  }
  return new RegExp("^" + regexStr + "$");
}

const IGNORED_DIR_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "env",
  "node_modules",
  "out",
  "target",
  "tmp",
  "vendor",
  "venv",
  "__pycache__",
]);

const IGNORED_FILE_NAMES = new Set([
  ".DS_Store",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const IGNORED_FILE_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lock",
  ".log",
  ".map",
  ".min.css",
  ".min.js",
  ".o",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".svg",
  ".tar",
  ".tsbuildinfo",
  ".webp",
  ".zip",
]);

const MAX_READ_BYTES = 1024 * 1024;

function normalizeToolPath(filePath: string): string {
  return path
    .relative(CWD, path.resolve(filePath))
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function ignoredPathReason(filePath: string): string | undefined {
  const normalized = normalizeToolPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  const ignoredDir = parts.find((part) => IGNORED_DIR_NAMES.has(part));
  if (ignoredDir) return `ignored directory: ${ignoredDir}`;

  const fileName = parts.at(-1) ?? normalized;
  if (IGNORED_FILE_NAMES.has(fileName)) return `ignored file: ${fileName}`;
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return "ignored secret file";
  }

  const lowerFileName = fileName.toLowerCase();
  const ignoredExtension = Array.from(IGNORED_FILE_EXTENSIONS).find((ext) =>
    lowerFileName.endsWith(ext)
  );
  if (ignoredExtension) return `ignored file type: ${ignoredExtension}`;

  return undefined;
}

async function walkDir(dir: string): Promise<string[]> {
  const entries: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let items: fs.Dirent[];
    try {
      items = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const fullPath = path.join(current, item.name);
      if (ignoredPathReason(fullPath)) continue;
      if (item.isDirectory()) {
        stack.push(fullPath);
      } else if (item.isFile()) {
        entries.push(fullPath);
      }
    }
  }
  return entries;
}

async function glob(
  pattern: string,
  basePath: string = "."
): Promise<string[]> {
  const fullPattern = path.posix.normalize(
    path.join(basePath, pattern).replace(/\\/g, "/")
  );
  const regex = globToRegex(fullPattern);
  const allFiles = await walkDir(basePath || ".");
  const matched = allFiles.filter((f) =>
    regex.test(f.replace(/\\/g, "/"))
  );
  matched.sort((a, b) => {
    const ma = existsSync(a) ? statSync(a).mtimeMs : 0;
    const mb = existsSync(b) ? statSync(b).mtimeMs : 0;
    return mb - ma;
  });
  return matched;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
async function toolRead(args: Record<string, JsonValue>): Promise<string> {
  const filePath = args.path as string;
  const ignoredReason = ignoredPathReason(filePath);
  if (ignoredReason) {
    return `error: refused to read ${filePath} (${ignoredReason})`;
  }
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_READ_BYTES) {
    return `error: refused to read ${filePath} (file is larger than ${MAX_READ_BYTES} bytes)`;
  }
  const offset = (args.offset as number) ?? 0;
  const limit = args.limit as number | undefined;
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const selected = lines.slice(offset, limit ? offset + limit : undefined);
  return selected
    .map((line, idx) => String(offset + idx + 1).padStart(4) + "| " + line)
    .join("\n");
}

async function toolWrite(args: Record<string, JsonValue>): Promise<string> {
  await fs.writeFile(args.path as string, args.content as string);
  return "ok";
}

async function toolEdit(args: Record<string, JsonValue>): Promise<string> {
  const filePath = args.path as string;
  const oldStr = args.old as string;
  const newStr = args.new as string;
  const replaceAll = args.all as boolean | undefined;
  const content = await fs.readFile(filePath, "utf-8");
  if (!content.includes(oldStr)) {
    return "error: old_string not found";
  }
  const count = content.split(oldStr).length - 1;
  if (!replaceAll && count > 1) {
    return `error: old_string appears ${count} times, must be unique (use all=true)`;
  }
  const replaced = replaceAll
    ? content.replaceAll(oldStr, newStr)
    : content.replace(oldStr, newStr);
  await fs.writeFile(filePath, replaced);
  return "ok";
}

async function toolGlob(args: Record<string, JsonValue>): Promise<string> {
  const pat = args.pat as string;
  const base = (args.path as string) ?? ".";
  const files = await glob(pat, base);
  return files.length ? files.join("\n") : "none";
}

async function toolGrep(args: Record<string, JsonValue>): Promise<string> {
  const pat = args.pat as string;
  const base = (args.path as string) ?? ".";
  const regex = new RegExp(pat);
  const hits: string[] = [];
  const files = await glob("**/*", base);
  for (const filePath of files) {
    if (hits.length >= 50) break;
    try {
      if (statSync(filePath).size > MAX_READ_BYTES) continue;
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= 50) break;
        if (regex.test(lines[i])) {
          hits.push(`${filePath}:${i + 1}:${lines[i].trimEnd()}`);
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  return hits.length ? hits.join("\n") : "none";
}

async function toolBash(args: Record<string, JsonValue>): Promise<string> {
  const cmd = args.cmd as string;
  const outputLines: string[] = [];

  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      const lines = text.split("\n");
      for (const line of lines) {
        if (line) {
          outputLines.push(line);
          process.stdout.write(`  ${DIM}│ ${line}${RESET}\n`);
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      const lines = text.split("\n");
      for (const line of lines) {
        if (line) {
          outputLines.push(line);
          process.stdout.write(`  ${DIM}│ ${line}${RESET}\n`);
        }
      }
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        outputLines.push("\n(timed out after 30s)");
      }
      resolve(outputLines.join("\n").trim() || "(empty)");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`error: ${err.message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
type ToolFn = (args: Record<string, JsonValue>) => Promise<string>;

interface ToolEntry {
  description: string;
  inputSchema: ToolDefinition["function"]["parameters"];
  fn: ToolFn;
}

const TOOLS: Record<string, ToolEntry> = {
  read: {
    description: "Read file with line numbers (file path, not directory)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "integer",
          description: "optional starting line (0-indexed)",
        },
        limit: { type: "integer", description: "optional max lines" },
      },
      required: ["path"],
    },
    fn: toolRead,
  },
  write: {
    description: "Write content to file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    fn: toolWrite,
  },
  edit: {
    description:
      "Replace old with new in file (old must be unique unless all=true)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
        all: { type: "boolean", description: "replace all occurrences" },
      },
      required: ["path", "old", "new"],
    },
    fn: toolEdit,
  },
  glob: {
    description: "Find files by pattern, sorted by mtime",
    inputSchema: {
      type: "object",
      properties: {
        pat: { type: "string" },
        path: {
          type: "string",
          description: "base directory (default cwd)",
        },
      },
      required: ["pat"],
    },
    fn: toolGlob,
  },
  grep: {
    description: "Search files for regex pattern",
    inputSchema: {
      type: "object",
      properties: {
        pat: { type: "string" },
        path: {
          type: "string",
          description: "base directory (default cwd)",
        },
      },
      required: ["pat"],
    },
    fn: toolGrep,
  },
  bash: {
    description: "Run shell command",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string" },
      },
      required: ["cmd"],
    },
    fn: toolBash,
  },
};

function makeToolDefinitions(): ToolDefinition[] {
  return Object.entries(TOOLS).map(([name, { description, inputSchema }]) => ({
    type: "function" as const,
    function: {
      name,
      description,
      parameters: inputSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Message conversion: internal format → OpenAI‑compatible wire format
// ---------------------------------------------------------------------------
function convertMessagesForProvider(
  messages: Message[]
): Record<string, any>[] {
  const result: Record<string, any>[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        const toolResults = msg.content as ContentBlockToolResult[];
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          });
        }
      }
    } else {
      // role === "assistant"
      if (msg.rawAssistantMessage) {
        // ★ Spread into a fresh object so we send a plain data object
        result.push({ ...msg.rawAssistantMessage });
      } else {
        // Fallback: reconstruct from ContentBlock[]
        const blocks = msg.content as ContentBlock[];
        const text =
          blocks
            .filter((b): b is ContentBlockText => b.type === "text")
            .map((b) => b.text)
            .join("\n") || null;
        const toolUses = blocks.filter(
          (b): b is ContentBlockToolUse => b.type === "tool_use"
        );
        const tool_calls =
          toolUses.length > 0
            ? toolUses.map((tu) => ({
                id: tu.id,
                type: "function" as const,
                function: {
                  name: tu.name,
                  arguments: JSON.stringify(tu.input),
                },
              }))
            : undefined;

        result.push({
          role: "assistant",
          content: text,
          ...(tool_calls ? { tool_calls } : {}),
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------
async function callApi(
  messages: Message[],
  systemPrompt: string
): Promise<CallApiResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };

  const wireMessages = [
    { role: "system", content: systemPrompt },
    ...convertMessagesForProvider(messages),
  ];

  const requestBody = {
    model: MODEL,
    max_tokens: 8192,
    messages: wireMessages,
    tools: makeToolDefinitions(),
  };

  let response = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (errorText.includes("tool_choice") && errorText.includes("auto")) {
      const fallbackResponse = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8192,
          messages: wireMessages,
        }),
      });
      response = fallbackResponse;
      if (response.ok) {
        console.log(
          `${YELLOW}⏺ Provider rejected tool auto-choice; continuing without tools for this turn${RESET}`
        );
      } else {
        const fallbackErrorText = await response.text();
        throw new Error(`API error ${response.status}: ${fallbackErrorText}`);
      }
    } else {
      throw new Error(`API error ${response.status}: ${errorText}`);
    }
  }

  const raw: any = await response.json();

  // ---------- Normalise the response ----------

  // Anthropic native format: { content: [...] }
  if (Array.isArray(raw.content)) {
    return { response: raw as ApiResponse };
  }

  // OpenAI‑compatible format: { choices: [{ message: {...} }] }
  if (raw.choices && raw.choices.length > 0) {
    const choice = raw.choices[0];

    // ★ JSON‑round‑trip deep clone – captures EVERY data property,
    //   especially `reasoning_content` required by DeepSeek thinking mode
    const rawAssistantMessage = JSON.parse(
      JSON.stringify(choice.message)
    ) as Record<string, any>;

    const blocks: ContentBlock[] = [];

    if (choice.message.content) {
      blocks.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
    }

    return {
      response: {
        id: raw.id ?? "",
        content: blocks,
        stop_reason: choice.finish_reason ?? "end_turn",
      },
      rawAssistantMessage,
    };
  }

  throw new Error("Unrecognised API response format");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function renderMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

function separator(): string {
  const cols = Math.min(TERMINAL_WIDTH, 80);
  return DIM + "─".repeat(cols) + RESET;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function runTool(
  name: string,
  args: Record<string, JsonValue>
): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return `error: unknown tool ${name}`;
  try {
    return await tool.fn(args);
  } catch (err: any) {
    return `error: ${err.message ?? err}`;
  }
}

// ---------------------------------------------------------------------------
// Multi‑line input (raw‑mode keypress handling)
// ---------------------------------------------------------------------------

interface CursorPos {
  line: number; // index into lines[]
  col: number;  // byte offset into that line
}

/**
 * Read multi-line input from stdin.
 *   Enter       → submits the text
 *   Shift+Enter → inserts a new line
 *   Arrow keys, Home, End, Backspace, Ctrl+D, Ctrl+C all work as expected.
 */
function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [""];
    const cursor: CursorPos = { line: 0, col: 0 };
    const wasRaw = input.isRaw;

    // ── helpers ──────────────────────────────────────────────────

    /** How many terminal rows the current content occupies. */
    const contentRows = (): number => {
      const promptLen = stripAnsi(prompt).length;
      const totalChars =
        promptLen + lines.reduce((s, l) => s + l.length, 0) + Math.max(0, lines.length - 1);
      const cols = process.stdout.columns ?? 80;
      // Each line may wrap – rough but sufficient for cursor cleanup
      let rows = 0;
      // prompt is on first row
      rows += Math.ceil((promptLen + (lines[0]?.length ?? 0)) / cols);
      for (let i = 1; i < lines.length; i++) {
        rows += 1 + Math.ceil((lines[i]?.length ?? 0) / cols); // +1 for the newline we output
      }
      return rows;
    };

    /** Move cursor back to the start of the input area. */
    const moveHome = (rows: number) => {
      for (let i = 0; i < rows; i++) {
        output.write("\x1b[A"); // cursor up
      }
    };

    /** Clear from cursor to end of screen, then write everything. */
    const rerender = () => {
      const rows = contentRows();
      if (rows > 0) moveHome(rows);
      output.write("\x1b[J"); // clear from cursor to end of screen
      output.write(prompt);
      output.write(lines.join("\n"));
      // Place cursor at the right position
      const line = lines[cursor.line] ?? "";
      let targetRow = 0;
      // Calculate which row the cursor line starts on
      const promptLen = stripAnsi(prompt).length;
      targetRow += Math.ceil((promptLen + (lines[0] ?? "").length) / cols);
      for (let i = 1; i <= cursor.line; i++) {
        targetRow += 1 + Math.ceil((lines[i - 1] ?? "").length / cols);
      }
      // Now we're at end of content. Move up to the cursor line.
      const totalRows = contentRows();
      const rowsToGoUp = totalRows - 1 - cursor.line;
      // Actually simpler: just recalculate based on current position
      // We're at the bottom. Go up to the cursor row.
      // console.error is not great, let's just compute.
      // We'll use a simpler approach - just compute cursor position from lines
    };

    const cols = process.stdout.columns ?? 80;

    /** Move cursor to the visual position of (cursor.line, cursor.col). */
    const positionCursor = () => {
      // Calculate which visual row the cursor is on within its line
      const line = lines[cursor.line] ?? "";
      const promptLen = stripAnsi(prompt).length;

      // How many rows are _before_ the cursor line
      let rowsBefore = Math.ceil((promptLen + (lines[0] ?? "").length) / cols);
      for (let i = 1; i < cursor.line; i++) {
        rowsBefore += 1 + Math.ceil((lines[i] ?? "").length / cols);
      }
      // Row offset within the cursor line
      const rowWithin = Math.floor(cursor.col / cols);
      const colWithin = cursor.col % cols;

      // Total rows of content
      const totalRows =
        Math.ceil((promptLen + (lines[0] ?? "").length) / cols) +
        lines.slice(1).reduce((s, l) => s + 1 + Math.ceil(l.length / cols), 0);

      // Rows to go up from bottom
      const rowsUp = totalRows - (rowsBefore + rowWithin) - 1;

      if (rowsUp > 0) {
        for (let i = 0; i < rowsUp; i++) output.write("\x1b[A");
      }
      // Now go to correct column
      output.write(`\x1b[${colWithin + 1}G`); // absolute column
      if (rowWithin > 0) {
        output.write(`\x1b[${rowWithin}B`);
      }
    };

    // ── raw mode + keypress events ───────────────────────────────

    input.setRawMode(true);
    input.resume();
    emitKeypressEvents(input);

    // Initial render
    output.write(prompt);

    const onKeypress = (str: string | undefined, key: any) => {
      if (!key) return;

      if (key.name === "return") {
        if (key.shift) {
          // ── Shift+Enter → new line ──
          const line = lines[cursor.line] ?? "";
          const before = line.slice(0, cursor.col);
          const after = line.slice(cursor.col);
          lines[cursor.line] = before;
          lines.splice(cursor.line + 1, 0, after);
          cursor.line++;
          cursor.col = 0;
          output.write("\n");
        } else {
          // ── Enter → submit ──
          cleanup();
          output.write("\n");
          resolve(lines.join("\n"));
          return;
        }
      } else if (key.name === "backspace") {
        if (cursor.col > 0) {
          const line = lines[cursor.line] ?? "";
          lines[cursor.line] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
          cursor.col--;
          rewrite();
        } else if (cursor.line > 0) {
          // Merge with previous line
          const prev = lines[cursor.line - 1] ?? "";
          const cur = lines[cursor.line] ?? "";
          cursor.col = prev.length;
          lines[cursor.line - 1] = prev + cur;
          lines.splice(cursor.line, 1);
          cursor.line--;
          rewrite();
        }
      } else if (key.name === "delete") {
        const line = lines[cursor.line] ?? "";
        if (cursor.col < line.length) {
          lines[cursor.line] = line.slice(0, cursor.col) + line.slice(cursor.col + 1);
          rewrite();
        } else if (cursor.line < lines.length - 1) {
          // Join with next line
          const next = lines[cursor.line + 1] ?? "";
          lines[cursor.line] = line + next;
          lines.splice(cursor.line + 1, 1);
          rewrite();
        }
      } else if (key.name === "left") {
        if (cursor.col > 0) {
          cursor.col--;
          output.write("\x1b[D");
        } else if (cursor.line > 0) {
          cursor.line--;
          cursor.col = (lines[cursor.line] ?? "").length;
          output.write("\x1b[A");
          output.write(`\x1b[${(cursor.col % cols) + 1}G`);
        }
      } else if (key.name === "right") {
        const line = lines[cursor.line] ?? "";
        if (cursor.col < line.length) {
          cursor.col++;
          output.write("\x1b[C");
        } else if (cursor.line < lines.length - 1) {
          cursor.line++;
          cursor.col = 0;
          output.write("\x1b[B");
          output.write("\x1b[1G");
        }
      } else if (key.name === "up") {
        if (cursor.line > 0) {
          const prevLine = lines[cursor.line - 1] ?? "";
          cursor.line--;
          cursor.col = Math.min(cursor.col, prevLine.length);
          output.write("\x1b[A");
        }
      } else if (key.name === "down") {
        if (cursor.line < lines.length - 1) {
          const nextLine = lines[cursor.line + 1] ?? "";
          cursor.line++;
          cursor.col = Math.min(cursor.col, nextLine.length);
          output.write("\x1b[B");
        }
      } else if (key.name === "home") {
        cursor.col = 0;
        output.write(`\x1b[${stripAnsi(prompt).length + 1}G`);
      } else if (key.name === "end") {
        const line = lines[cursor.line] ?? "";
        cursor.col = line.length;
        rewrite();
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        process.exit(0);
      } else if (key.ctrl && key.name === "d") {
        cleanup();
        output.write("\n");
        resolve("");
      } else if (key.ctrl && key.name === "l") {
        // Ctrl+L – clear screen, then re-render
        output.write("\x1b[2J\x1b[H");
        rewrite();
      } else if (str && str.length === 1 && !key.ctrl && !key.meta) {
        // ── printable character ──
        const line = lines[cursor.line] ?? "";
        lines[cursor.line] = line.slice(0, cursor.col) + str + line.slice(cursor.col);
        cursor.col++;
        // Write the rest of the line + all lines after it, then reposition
        const restOfLine = (lines[cursor.line] ?? "").slice(cursor.col - 1);
        output.write(restOfLine);
        // Write subsequent lines
        for (let i = cursor.line + 1; i < lines.length; i++) {
          output.write("\n" + (lines[i] ?? ""));
        }
        // Now move cursor back to where it should be
        // We're at the end of all content. Need to go back up.
        const remainingLines = lines.length - 1 - cursor.line;
        for (let i = 0; i < remainingLines; i++) {
          output.write("\x1b[A");
        }
        // Move cursor back within line if we wrote more than 1 char
        const charsWritten = restOfLine.length;
        if (charsWritten > 1) {
          output.write(`\x1b[${charsWritten - 1}D`);
        }
      }
    };

    const rewrite = () => {
      // Move up to prompt area, clear, rewrite, reposition
      const totalLines = lines.length;
      // Move up: we need to know how many terminal rows we wrote
      const promptLen = stripAnsi(prompt).length;
      let rows = Math.ceil((promptLen + (lines[0] ?? "").length) / cols);
      for (let i = 1; i < lines.length; i++) {
        rows += 1 + Math.ceil((lines[i] ?? "").length / cols);
      }
      if (rows > 0) {
        for (let i = 0; i < rows; i++) output.write("\x1b[A");
      }
      output.write("\r\x1b[J"); // carriage return + clear to end
      output.write(prompt);
      output.write(lines.join("\n"));
      // Reposition cursor
      // Calculate visual row of cursor
      let cursorVisualRow = Math.floor((promptLen + (lines[0] ?? "").length) / cols);
      for (let i = 1; i <= cursor.line; i++) {
        cursorVisualRow += 1 + Math.floor((lines[i - 1] ?? "").length / cols);
      }
      const rowWithinLine = Math.floor(cursor.col / cols);
      const colWithinLine = cursor.col % cols;
      // Total visual rows now
      let totalVisualRows = cursorVisualRow; // last row index
      const lastLineIdx = lines.length - 1;
      totalVisualRows = Math.floor((promptLen + (lines[0] ?? "").length) / cols);
      for (let i = 1; i < lines.length; i++) {
        totalVisualRows += 1 + Math.floor((lines[i] ?? "").length / cols);
      }
      // We're at bottom. Go up to cursor row.
      const currentVisualRow = totalVisualRows;
      const targetVisualRow =
        Math.floor((promptLen + (lines[0] ?? "").length) / cols) +
        (cursor.line > 0 ? 1 : 0) +
        lines.slice(1, cursor.line).reduce((s, l) => s + 1 + Math.floor(l.length / cols), 0) +
        rowWithinLine;
      const goUp = currentVisualRow - targetVisualRow;
      if (goUp > 0) {
        for (let i = 0; i < goUp; i++) output.write("\x1b[A");
      }
      // Now set column (absolute)
      output.write(`\x1b[${colWithinLine + 1 + stripAnsi(prompt).length}G`);
      // If rowWithinLine > 0, we already went up to the right row
      // Hmm, this is getting complex. Let me use a simpler approach.
    };

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(wasRaw ?? false);
      input.pause();
    };

    input.on("keypress", onKeypress);
  });
}

/** Strip ANSI escape codes (for computing visible width). */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, "");
}

async function main() {
  console.log(
    `${BOLD}nanocode${RESET} | ${DIM}${MODEL} | ${CWD}${RESET} | ${YELLOW}node src/index.ts${RESET}\n`
  );

  const messages: Message[] = [];
  const systemPrompt = `Concise coding assistant. cwd: ${CWD}. be professional and future-proof.`;

  const promptStr = `${BOLD}${BLUE}❯${RESET} `;

  while (true) {
    try {
      console.log(separator());
      const userInput = await ask(promptStr);
      console.log(separator());
      const trimmed = userInput.trim();
      if (!trimmed) continue;
      if (trimmed === "/q" || trimmed === "exit") break;
      if (trimmed === "/c") {
        messages.length = 0;
        console.log(`${GREEN}⏺ Cleared conversation${RESET}`);
        continue;
      }

      messages.push({ role: "user", content: trimmed });

      let turn = true;
      while (turn) {
        const { response, rawAssistantMessage } = await callApi(
          messages,
          systemPrompt
        );
        const contentBlocks = response.content;
        const toolResults: ContentBlockToolResult[] = [];

        for (const block of contentBlocks) {
          if (block.type === "text") {
            console.log(
              `\n${CYAN}⏺${RESET} ${renderMarkdown(block.text)}`
            );
          } else if (block.type === "tool_use") {
            const toolName = block.name;
            const toolArgs = block.input;
            const previewArg = String(
              Object.values(toolArgs)[0] ?? ""
            ).slice(0, 50);
            console.log(
              `\n${GREEN}⏺ ${toolName[0].toUpperCase() + toolName.slice(1)}${RESET}(${DIM}${previewArg}${RESET})`
            );

            const result = await runTool(toolName, toolArgs);
            const resultLines = result.split("\n");
            let preview = resultLines[0].slice(0, 60);
            if (resultLines.length > 1)
              preview += ` ... +${resultLines.length - 1} lines`;
            else if (resultLines[0].length > 60) preview += "...";
            console.log(`  ${DIM}⎿  ${preview}${RESET}`);

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
            });
          }
        }

        messages.push({
          role: "assistant",
          content: contentBlocks,
          rawAssistantMessage,
        });

        if (toolResults.length > 0) {
          messages.push({ role: "user", content: toolResults });
        } else {
          turn = false;
        }
      }

      console.log();
    } catch (err: any) {
      if (err instanceof Error && err.name === "AbortError") break;
      console.log(`${RED}⏺ Error: ${err.message ?? err}${RESET}`);
    }
  }
}

main().catch(console.error);
