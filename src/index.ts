#!/usr/bin/env -S npx tsx
/**
 * nanocode.ts — minimal claude code alternative in TypeScript
 *
 * Requirements:
 *   Node.js >= 18 (built‑in fetch)
 *
 * Environment variables:
 *   API_KEY           – your API key (required for remote providers)
 *   API_URL           – chat completions endpoint
 *                       (default: https://openrouter.ai/api/v1/chat/completions)
 *   MODEL             – model name (default: deepseek-v4-flash)
 *   OLLAMA_BASE_URL   – Ollama base URL (default: http://localhost:11434)
 *                         Only used when API_URL points to an Ollama endpoint
 */

import * as fs from "node:fs/promises";
import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

import { swarmCLI, type SwarmPattern } from "./swarm.ts";

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
// Token budget config
// ---------------------------------------------------------------------------
const MAX_INPUT_TOKENS = 12_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const TOOL_RESULT_MAX_CHARS = 4_000;
const CACHE_TTL_MS = 60_000;

// ----- Command history -----
const inputHistory: string[] = [];
let historyCursor = -1;
let savedInputBeforeHistory: string | null = null;

// ---------------------------------------------------------------------------
// Ollama detection & config
// ---------------------------------------------------------------------------
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:0.8b";

/** Return true when API_URL looks like an Ollama endpoint. */
function isOllamaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Only match native /api/chat on local instances
    return (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      u.pathname === "/api/chat"
    );
  } catch {
    return false;
  }
}

const IS_OLLAMA = isOllamaUrl(API_URL);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonArray = JsonValue[];

interface ToolJsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, ToolJsonSchema>;
  items?: ToolJsonSchema;
  required?: string[];
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolJsonSchema>;
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

function estimateTokens(messages: Message[], systemPrompt: string): number {
  let total = systemPrompt.length / CHARS_PER_TOKEN_ESTIMATE;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += msg.content.length / CHARS_PER_TOKEN_ESTIMATE;
    } else {
      total += JSON.stringify(msg.content).length / CHARS_PER_TOKEN_ESTIMATE;
    }
    if (msg.rawAssistantMessage) {
      total += JSON.stringify(msg.rawAssistantMessage).length / CHARS_PER_TOKEN_ESTIMATE;
    }
  }
  return Math.ceil(total);
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return (
    text.slice(0, TOOL_RESULT_MAX_CHARS) +
    `\n… [truncated – ${text.length} chars total, use offset/limit or narrower queries to explore]`
  );
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
    } else if (ch && ".+^$()[]{}|\\".includes(ch)) {
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

// ---------------------------------------------------------------------------
// Memory tool
// ---------------------------------------------------------------------------
const MEMORY_DIR = process.env.MEMORY_DIR
  ? path.resolve(process.env.MEMORY_DIR)
  : path.join(CWD, ".memory");

function slugifyKey(key: string): string {
  return (
    key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

async function ensureMemoryDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true }).catch(() => { });
}

async function toolMemory(
  args: Record<string, JsonValue>
): Promise<string> {
  const op = String(args.operation);
  const rawKey = String(args.key ?? "");
  const content = typeof args.content === "string" ? args.content : "";
  const title = String(args.title ?? rawKey);
  const tags = String(args.tags ?? "");
  const query = String(args.query ?? "");

  const key = slugifyKey(rawKey);
  const filePath = path.join(MEMORY_DIR, `${key}.md`);

  await ensureMemoryDir();

  switch (op) {
    case "save": {
      if (!content) return "error: content is required for save";
      const dateLine = `date: ${new Date().toISOString()}`;
      const tagsLine = tags
        ? `tags: ${tags
          .split(",")
          .map((t) => t.trim())
          .join(", ")}`
        : "";
      const header = [`# ${title}`, dateLine, tagsLine]
        .filter(Boolean)
        .join("\n");
      await fs.writeFile(filePath, `${header}\n\n${content}\n`, "utf-8");
      return `ok: saved memory "${key}"`;
    }
    case "load": {
      if (!existsSync(filePath)) return `error: memory "${key}" not found`;
      return await fs.readFile(filePath, "utf-8");
    }
    case "delete": {
      if (!existsSync(filePath)) return `error: memory "${key}" not found`;
      await fs.unlink(filePath);
      return `ok: deleted memory "${key}"`;
    }
    case "list": {
      const files = await fs.readdir(MEMORY_DIR).catch(() => []);
      const entries: string[] = [];
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const text = await fs
          .readFile(path.join(MEMORY_DIR, f), "utf-8")
          .catch(() => "");
        const firstLine = text.split("\n")[0]?.replace(/^#\s*/, "") || f;
        const tagMatch = text.match(/^tags:\s*(.+)$/m);
        const tagStr = tagMatch ? ` [${tagMatch[1]}]` : "";
        entries.push(`${f.replace(/\.md$/, "")}: ${firstLine}${tagStr}`);
      }
      return entries.length ? entries.join("\n") : "no memories yet";
    }
    case "search": {
      if (!query) return "error: query is required for search";
      const files = await fs.readdir(MEMORY_DIR).catch(() => []);
      const results: string[] = [];
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const text = await fs
          .readFile(path.join(MEMORY_DIR, f), "utf-8")
          .catch(() => "");
        if (text.toLowerCase().includes(query.toLowerCase())) {
          results.push(`--- ${f} ---\n${text}\n`);
        }
      }
      return results.length ? results.join("\n") : "none";
    }
    default:
      return `error: unknown operation "${op}". Use save, load, delete, list, or search.`;
  }
}

const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_READ_LINES = 50;
const MAX_READ_LINES = 200;
const MAX_READ_OUTPUT_CHARS = 4_000;
const MAX_READ_LINE_CHARS = 2_000;

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
    let items: Dirent[];
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
function parseNonNegativeInteger(
  value: JsonValue | undefined,
  fallback: number
): number | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

async function toolRead(args: Record<string, JsonValue>): Promise<string> {
  const filePath = args.path;
  if (typeof filePath !== "string" || !filePath.trim()) {
    return "error: path must be a non-empty string";
  }

  const ignoredReason = ignoredPathReason(filePath);
  if (ignoredReason) {
    return `error: refused to read ${filePath} (${ignoredReason})`;
  }

  const offset = parseNonNegativeInteger(args.offset, 0);
  if (offset === undefined) {
    return "error: offset must be a non-negative integer";
  }

  const requestedLimit = parseNonNegativeInteger(args.limit, DEFAULT_READ_LINES);
  if (requestedLimit === undefined || requestedLimit === 0) {
    return "error: limit must be a positive integer";
  }
  const limit = Math.min(requestedLimit, MAX_READ_LINES);

  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    return `error: refused to read ${filePath} (not a file)`;
  }

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let currentLine = 0;
  let outputChars = 0;
  let hitOutputLimit = false;
  let hitLineLimit = false;
  let hasMoreLines = false;

  try {
    for await (const rawLine of rl) {
      if (currentLine < offset) {
        currentLine++;
        continue;
      }

      if (lines.length >= limit) {
        hasMoreLines = true;
        break;
      }

      let line = rawLine;
      if (line.length > MAX_READ_LINE_CHARS) {
        line = `${line.slice(0, MAX_READ_LINE_CHARS)}... [line truncated]`;
        hitLineLimit = true;
      }

      const numberedLine = `${String(currentLine + 1).padStart(4)}| ${line}`;
      if (outputChars + numberedLine.length > MAX_READ_OUTPUT_CHARS) {
        hitOutputLimit = true;
        hasMoreLines = true;
        break;
      }

      lines.push(numberedLine);
      outputChars += numberedLine.length + 1;
      currentLine++;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!lines.length) {
    return `empty: no lines at or after offset ${offset}`;
  }

  const notes: string[] = [];
  if (requestedLimit > MAX_READ_LINES) {
    notes.push(`limit capped at ${MAX_READ_LINES} lines`);
  }
  if (hasMoreLines) {
    notes.push(`more available; continue with offset ${offset + lines.length}`);
  }
  if (hitLineLimit) {
    notes.push(`long lines capped at ${MAX_READ_LINE_CHARS} chars`);
  }
  if (hitOutputLimit) {
    notes.push(`output capped at ${MAX_READ_OUTPUT_CHARS} chars`);
  }

  const header = `file: ${normalizeToolPath(filePath)} (${stats.size} bytes), lines ${offset + 1
    }-${offset + lines.length}${notes.length ? `; ${notes.join("; ")}` : ""}`;

  return `${header}\n${lines.join("\n")}`;
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
  if (!files.length) return "none";

  const cappedFiles = files.slice(0, 50);
  let output = cappedFiles.join("\n");
  if (files.length > cappedFiles.length) {
    output += `\n… ${files.length - cappedFiles.length} more paths omitted`;
  }
  if (output.length > 2_000) {
    output = `${output.slice(0, 2_000)}\n… [glob output truncated]`;
  }
  return output;
}

async function toolGrep(args: Record<string, JsonValue>): Promise<string> {
  const pat = args.pat as string;
  const base = (args.path as string) ?? ".";
  const regex = new RegExp(pat);
  const hits: string[] = [];
  const files = await glob("**/*", base);
  let omitted = false;
  for (const filePath of files) {
    if (hits.length >= 20) {
      omitted = true;
      break;
    }
    try {
      if (statSync(filePath).size > MAX_READ_BYTES) continue;
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= 20) {
          omitted = true;
          break;
        }
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          const trimmedLine = line.trimEnd();
          const cappedLine =
            trimmedLine.length > 200
              ? `${trimmedLine.slice(0, 200)}… [line truncated]`
              : trimmedLine;
          hits.push(`${filePath}:${i + 1}:${cappedLine}`);
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  if (omitted) hits.push("… further matches omitted");
  if (!hits.length) return "none";
  const output = hits.join("\n");
  return output.length > 2_000 ? `${output.slice(0, 2_000)}\n… [grep output truncated]` : output;
}

async function toolBash(args: Record<string, JsonValue>): Promise<string> {
  const cmd = args.cmd as string;
  const outputLines: string[] = [];
  const FULL_OUTPUT_MAX_CHARS = 4_000;

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
      const joined = outputLines.join("\n").trim();
      if (joined.length > FULL_OUTPUT_MAX_CHARS) {
        resolve(`${joined.slice(0, FULL_OUTPUT_MAX_CHARS)}\n… [output truncated]`);
      } else {
        resolve(joined || "(empty)");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`error: ${err.message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Ollama Subagent Helpers
// ---------------------------------------------------------------------------
async function callOllamaChatStream(
  messages: Record<string, any>[],
  model: string
): Promise<string> {
  const baseUrl = API_URL.replace(/\/+$/, "");
  const url = `${baseUrl}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };

  const body = {
    model,
    messages,
    stream: true,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama chat error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  let fullContent = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";  // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.message?.content) {
            const token = parsed.message.content;
            fullContent += token;
            process.stdout.write(token);
          }
        } catch {
          // ignore parse errors for incomplete lines
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          process.stdout.write(parsed.message.content);
        }
      } catch { }
    }
  } finally {
    reader.releaseLock();
  }

  // Clean newline after stream
  process.stdout.write("\n");
  return fullContent;
}

// -------------------- new toolOllamaCode --------------------
// ---------------------------------------------------------------------------
// Updated toolOllamaCode – SEARCH/REPLACE for existing files, full content for new
// ---------------------------------------------------------------------------
async function toolOllamaCode(args: Record<string, JsonValue>): Promise<string> {
  const instruction = args.instruction as string;
  const fileContext = (args.file_context as string) ?? "";
  const filePath = args.file_path as string;

  if (!filePath) {
    return "error: file_path is required";
  }

  const normalizedPath = normalizeToolPath(filePath);
  const reason = ignoredPathReason(normalizedPath);
  if (reason) {
    return `error: refused to write ${normalizedPath} (${reason})`;
  }

  // Determine if the file already exists (edit mode) or is new
  const fileExists = existsSync(normalizedPath);
  let existingContent = "";

  if (fileExists) {
    try {
      const stats = await fs.stat(normalizedPath);
      if (stats.size <= MAX_READ_BYTES) {
        existingContent = await fs.readFile(normalizedPath, "utf-8");
      } else {
        return `error: file ${normalizedPath} is too large (${stats.size} bytes)`;
      }
    } catch (err: any) {
      return `error: could not read ${normalizedPath}: ${err.message ?? err}`;
    }
  }

  // ---- System prompt for the subagent ----
  const systemMsg = {
    role: "system",
    content: fileExists
      ? [
        "You are an expert coding editor. You edit EXISTING files using SEARCH/REPLACE blocks.",
        "Rules:",
        "1. NEVER output the full file. Only output one or more SEARCH/REPLACE blocks.",
        "2. Block format:",
        "<<<<<<< SEARCH",
        "exact text to find (must match the file exactly, including indentation)",
        "=======",
        "replacement text",
        ">>>>>>> REPLACE",
        "3. The SEARCH block must be an exact, unique substring of the current file.",
        "4. If multiple changes are needed, use multiple SEARCH/REPLACE blocks.",
        "5. DO NOT include any explanation, markdown fences, or extra commentary.",
      ].join("\n")
      : [
        "You are an expert coding assistant. Create a NEW file from scratch.",
        "Give ONLY the final, complete file content.",
        "Do NOT include markdown fences, explanations, or extra text.",
      ].join("\n"),
  };

  // ---- User message ----
  let userContent = `Task: ${instruction}\nFile: ${normalizedPath}\n`;
  if (fileContext) {
    userContent += `Additional context:\n${fileContext}\n`;
  }
  if (fileExists) {
    userContent += `Current file content:\n\`\`\`\n${existingContent}\n\`\`\`\n`;
    userContent += `\nOutput the SEARCH/REPLACE blocks for the required changes.`;
  } else {
    userContent += `Output the complete file content.`;
  }

  const messages: any[] = [systemMsg, { role: "user", content: userContent }];

  // ---- Call Ollama and get the response ----
  process.stdout.write("\n");
  let rawOutput: string;
  try {
    rawOutput = await callOllamaChatStream(messages, OLLAMA_MODEL);
  } catch (err: any) {
    return `Error calling Ollama subagent: ${String(err.message ?? err).slice(0, 200)}`;
  }

  if (!rawOutput || rawOutput.trim().length === 0) {
    return "error: ollama_code returned empty response";
  }

  // ---- Handle response ----
  if (fileExists) {
    // ---------- Edit mode: parse SEARCH/REPLACE blocks ----------
    const blocks = parseSearchReplaceBlocks(rawOutput);

    if (blocks.length === 0) {
      return `error: no valid SEARCH/REPLACE blocks. First 500 chars: ${rawOutput.slice(0, 500)}`;
    }

    // Apply each block sequentially using the edit tool
    const results: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      // Use the existing edit tool – it does exact match and reports errors
      const editResult = await toolEdit({
        path: normalizedPath,
        old: block.search,
        new: block.replace,
      });

      if (editResult.startsWith("error:")) {
        results.push(
          `SEARCH/REPLACE block ${i + 1} failed:\n  SEARCH:\n"""\n${block.search}\n"""\n  ERROR: ${editResult}`
        );
        // stop on first failure to avoid corrupting the file further
        return `error: ${results.join("\n")}`;
      }

      results.push(`SEARCH/REPLACE block ${i + 1} applied successfully.`);
    }

    return `ok: applied ${blocks.length} edit block(s) to ${normalizedPath}`;
  } else {
    // ---------- New file mode: use whole content ----------
    let final = rawOutput.trim();
    // Remove outer code fence if the entire response is wrapped
    const wholeFenceRegex = /^```(?:\w*)\s*\n([\s\S]*)\n\s*```$/;
    const wholeMatch = final.match(wholeFenceRegex);
    if (wholeMatch) {
      final = wholeMatch[1]!;
    }

    await fs.writeFile(normalizedPath, final, "utf-8");
    const lines = final.split("\n").length;
    return `ok: wrote ${lines} lines to ${normalizedPath}`;
  }
}

// ---------------------------------------------------------------------------
// Parse SEARCH/REPLACE blocks from raw subagent output
// ---------------------------------------------------------------------------
function parseSearchReplaceBlocks(text: string): { search: string; replace: string }[] {
  const blocks: { search: string; replace: string }[] = [];
  const regex = /<<<<<<< SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const search = match[1] ?? "";
    const replace = match[2] ?? "";
    // Trim trailing newline added by the regex's non‑greedy capture
    blocks.push({ search, replace });
  }

  return blocks;
}

async function toolOllamaBatch(args: Record<string, JsonValue>): Promise<string> {
  const tasks = args.tasks as any[] | undefined;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return "error: tasks array is required and must not be empty";
  }

  const results: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const instruction = task.instruction as string;
    const filePath = task.file_path as string;
    const fileContext = (task.file_context as string) ?? "";

    if (!instruction || !filePath) {
      results.push(`[${i + 1}/${tasks.length}] ❌ skipped – missing instruction or file_path`);
      continue;
    }

    console.log(`  ${DIM}── batch task ${i + 1}/${tasks.length}: ${filePath}${RESET}`);
    const singleResult = await toolOllamaCode({ instruction, file_path: filePath, file_context: fileContext });
    // Strip the leading "ok: wrote …" / error part to get a short status
    const shortStatus = singleResult.startsWith("ok:")
      ? singleResult.split("to ").pop() ?? singleResult
      : singleResult.startsWith("error:")
        ? `❌ ${singleResult.slice(7)}`
        : singleResult;
    results.push(`[${i + 1}/${tasks.length}] ${shortStatus}`);
  }

  const MAX_BATCH_RESULT_LINES = 15;
  if (results.length > MAX_BATCH_RESULT_LINES) {
    const omitted = results.length - (MAX_BATCH_RESULT_LINES - 1);
    results.length = MAX_BATCH_RESULT_LINES - 1;
    results.push(`… and ${omitted} more tasks`);
  }

  return `Batch complete:\n${results.join("\n")}`;
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
    description:
      "Read a bounded window of a file with line numbers. Defaults to 200 lines and caps output to avoid wasting context; use offset/limit to page through large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "integer",
          description: "optional starting line (0-indexed, default 0)",
        },
        limit: {
          type: "integer",
          description: `optional max lines (default ${DEFAULT_READ_LINES}, cap ${MAX_READ_LINES})`,
        },
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
  ollama_code: {
    description:
      "Subagent: Use Ollama only for code generation/editing/refactoring tasks. Provide the target file_path; the result will be written directly to that file.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "The coding task or prompt to send to Ollama.",
        },
        file_context: {
          type: "string",
          description:
            "Optional: Content of relevant files if small enough. Format: '--- FILE PATH ---\\ncontent\\n--- END ---'.",
        },
        file_path: {
          type: "string",
          description: "REQUIRED: target file path relative to CWD. The generated code will be written here.",
        },
      },
      required: ["instruction", "file_path"],
    },
    fn: toolOllamaCode,
  },
  ollama_batch: {
    description:
      "Subagent batch: Use Ollama for multiple code generation/editing tasks in sequence. Each task requires instruction and file_path. Tasks are queued and executed one at a time (hardware-friendly).",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "Array of tasks, each with instruction, file_path, and optional file_context.",
          items: {
            type: "object",
            properties: {
              instruction: { type: "string", description: "The coding task for this file." },
              file_path: { type: "string", description: "Target file path." },
              file_context: { type: "string", description: "Optional: relevant file content." },
            },
            required: ["instruction", "file_path"],
          },
        },
      },
      required: ["tasks"],
    },
    fn: toolOllamaBatch,
  },
  memory: {
    description:
      "Persistent project memory. Save, load, delete, list, or search memory notes.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["save", "load", "delete", "list", "search"],
          description: "Memory operation to perform",
        },
        key: {
          type: "string",
          description: "Unique key for the memory (used as filename)",
        },
        content: {
          type: "string",
          description: "Memory content (Markdown) – required for save",
        },
        title: {
          type: "string",
          description: "Optional title; if omitted the key is used",
        },
        tags: {
          type: "string",
          description: "Comma-separated tags (optional)",
        },
        query: {
          type: "string",
          description: "Search query – required for search",
        },
      },
      required: ["operation", "key"],
    },
    fn: toolMemory,
  },
  swarm_invoke: {
    description:
      "Invoke a specific agent to perform a subtask. Use within multi-agent workflows to delegate work to specialist agents.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "ID of the agent to invoke (e.g., 'coder', 'reviewer')",
        },
        task: {
          type: "string",
          description: "The specific task to delegate to this agent",
        },
        context: {
          type: "string",
          description: "Additional context from previous steps",
        },
      },
      required: ["agent_id", "task"],
    },
    fn: async (args) => {
      await swarmCLI.init();
      const agent = swarmCLI.registry.get(args.agent_id as string);
      if (!agent) return `error: agent "${args.agent_id}" not found`;
      // In production: call LLM with agent's system prompt
      return `Agent ${agent.name} invoked for: ${args.task}`;
    },
  },

  swarm_broadcast: {
    description:
      "Broadcast a message to all agents in the swarm. Useful for sharing context or requesting input from multiple specialists.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message to broadcast to all agents",
        },
        exclude: {
          type: "string",
          description: "Comma-separated list of agent IDs to exclude",
        },
      },
      required: ["message"],
    },
    fn: async (args) => {
      await swarmCLI.init();
      const agents = swarmCLI.registry.getAll();
      const exclude = new Set((args.exclude as string || "").split(",").map((s) => s.trim()));
      const results: string[] = [];
      for (const agent of agents) {
        if (exclude.has(agent.id)) continue;
        results.push(`${agent.name}: received broadcast`);
      }
      return `Broadcast sent to ${results.length} agents\n${results.join("\n")}`;
    },
  },

  swarm_plan: {
    description:
      "Create an execution plan using the planner agent. Returns a structured plan with steps and agent assignments.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The high-level task to plan",
        },
        pattern: {
          type: "string",
          enum: ["supervisor", "pipeline", "swarm", "map-reduce"],
          description: "Execution pattern to use",
        },
      },
      required: ["task"],
    },
    fn: async (args) => {
      await swarmCLI.init();
      const planner = swarmCLI.registry.get("planner");
      if (!planner) return "error: planner agent not found";
      return `Plan for: ${args.task}\nPattern: ${args.pattern || "supervisor"}\n[Plan would be generated by LLM]`;
    },
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
  const wireMessages = [
    { role: "system", content: systemPrompt },
    ...convertMessagesForProvider(messages),
  ];

  const toolDefs = makeToolDefinitions();

  // -----------------------------------------------------------------------
  // Ollama native endpoint: /api/chat
  // -----------------------------------------------------------------------
  if (IS_OLLAMA && API_URL.includes("/api/chat")) {
    const ollamaUrl = new URL(API_URL);
    // If path is exactly /api/chat, keep it; otherwise use OLLAMA_BASE_URL
    const baseUrl = ollamaUrl.pathname === "/api/chat"
      ? OLLAMA_BASE_URL.replace(/\/+$/, "")
      : OLLAMA_BASE_URL.replace(/\/+$/, "");

    const ollamaRequestBody = {
      model: MODEL,
      messages: wireMessages,
      tools: toolDefs.map((t) => ({
        type: "function",
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      })),
      stream: false,
    };

    const ollamaHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: ollamaHeaders,
      body: JSON.stringify(ollamaRequestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error ${response.status}: ${errorText}`);
    }

    const raw: any = await response.json();
    const msg = raw.message ?? { role: "assistant", content: "" };
    const rawAssistantMessage = msg as Record<string, any>;
    const blocks: ContentBlock[] = [];

    if (typeof msg.content === "string" && msg.content) {
      blocks.push({ type: "text", text: msg.content });
    }

    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function ?? {};
        blocks.push({
          type: "tool_use",
          id: tc.id ?? `ollama_${Date.now()}`,
          name: fn.name ?? "",
          input: typeof fn.arguments === "string"
            ? JSON.parse(fn.arguments || "{}")
            : fn.arguments ?? {},
        });
      }
    }

    return {
      response: {
        id: raw.id ?? `ollama_${Date.now()}`,
        content: blocks,
        stop_reason: raw.done ? "end_turn" : null,
      },
      rawAssistantMessage,
    };
  }

  // -----------------------------------------------------------------------
  // OpenAI‑compatible endpoint (default path, including Ollama's /v1/…)
  // -----------------------------------------------------------------------
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };

  const requestBody = {
    model: MODEL,
    max_tokens: 8192,
    messages: wireMessages,
    tools: toolDefs,
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

async function callApiWithBudget(
  messages: Message[],
  systemPrompt: string
): Promise<CallApiResult> {
  while (
    messages.length > 2 &&
    estimateTokens(messages, systemPrompt) > MAX_INPUT_TOKENS
  ) {
    messages.shift();
    if (messages[0]?.role === "assistant") {
      messages.shift();
    }
  }
  return callApi(messages, systemPrompt);
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
  line: number;
  col: number;
}

interface ProjectFile {
  path: string;
  name: string;
  directory: string;
  mtimeMs: number;
}

interface MentionRange {
  line: number;
  startCol: number;
  endCol: number;
  query: string;
}

const FILE_PICKER_LIMIT = 10;
const FILE_INDEX_TTL_MS = 5_000;
let fileIndexCache: { createdAt: number; files: ProjectFile[] } | undefined;

async function getProjectFiles(): Promise<ProjectFile[]> {
  const now = Date.now();
  if (fileIndexCache && now - fileIndexCache.createdAt < FILE_INDEX_TTL_MS) {
    return fileIndexCache.files;
  }

  const files = (await walkDir(CWD))
    .map((filePath) => {
      const relativePath = normalizeToolPath(filePath);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        // If a file disappears while indexing, keep it low priority.
      }
      return {
        path: relativePath,
        name: path.basename(relativePath),
        directory: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
        mtimeMs,
      } satisfies ProjectFile;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  fileIndexCache = { createdAt: now, files };
  return files;
}

function activeMention(lines: string[], cursor: CursorPos): MentionRange | undefined {
  const line = lines[cursor.line] ?? "";
  const beforeCursor = line.slice(0, cursor.col);
  const at = beforeCursor.lastIndexOf("@");
  if (at < 0) return undefined;

  const charBeforeAt = at > 0 ? beforeCursor[at - 1] : "";
  if (charBeforeAt && !/\s|[(\[{,]/.test(charBeforeAt)) return undefined;

  const query = beforeCursor.slice(at + 1);
  if (/\s/.test(query)) return undefined;

  return { line: cursor.line, startCol: at, endCol: cursor.col, query };
}

function scoreFileMention(file: ProjectFile, query: string): number {
  if (!query) return 1000 + file.mtimeMs / 1_000_000_000;

  const q = query.toLowerCase();
  const full = file.path.toLowerCase();
  const name = file.name.toLowerCase();
  let score = 0;

  if (name === q) score += 1000;
  if (full === q) score += 900;
  if (name.startsWith(q)) score += 700;
  if (full.startsWith(q)) score += 550;
  if (name.includes(q)) score += 350;
  if (full.includes(q)) score += 250;

  let pos = -1;
  let fuzzy = 0;
  for (const ch of q) {
    pos = full.indexOf(ch, pos + 1);
    if (pos < 0) return score;
    fuzzy += 12;
  }

  return score + fuzzy - file.path.length / 100;
}

function findMentionSuggestions(
  files: ProjectFile[],
  mention: MentionRange | undefined
): ProjectFile[] {
  if (!mention) return [];

  return files
    .map((file) => ({ file, score: scoreFileMention(file, mention.query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, FILE_PICKER_LIMIT)
    .map(({ file }) => file);
}

function displayPathForMention(filePath: string): string {
  return filePath.includes(" ") ? `"${filePath.replaceAll('"', '\\"')}"` : filePath;
}

function insertMention(
  lines: string[],
  cursor: CursorPos,
  mention: MentionRange,
  selectedPath: string
) {
  const line = lines[mention.line] ?? "";
  const replacement = `@${displayPathForMention(selectedPath)}`;
  lines[mention.line] =
    line.slice(0, mention.startCol) + replacement + line.slice(mention.endCol);
  cursor.line = mention.line;
  cursor.col = mention.startCol + replacement.length;
}

function visualRows(text: string, cols: number): number {
  return Math.max(1, Math.ceil(Math.max(1, stripAnsi(text).length) / cols));
}

function selectedMentionPaths(text: string): string[] {
  const paths = new Set<string>();
  const mentionPattern = /(^|\s)@("(?:\\"|[^"])+"|\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(text))) {
    const raw = match[2];
    if (!raw) continue;
    const unquoted = raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1).replaceAll('\\"', '"')
      : raw;
    const resolved = path.resolve(CWD, unquoted);
    if (existsSync(resolved) && statSync(resolved).isFile() && !ignoredPathReason(resolved)) {
      paths.add(normalizeToolPath(resolved));
    }
  }

  return [...paths];
}

async function buildMentionContext(text: string): Promise<string> {
  const paths = selectedMentionPaths(text);
  if (!paths.length) return text;

  const sections: string[] = [];
  for (const filePath of paths) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > MAX_READ_BYTES) {
        sections.push(`--- @${filePath} skipped: file is larger than ${MAX_READ_BYTES} bytes ---`);
        continue;
      }
      const content = await fs.readFile(filePath, "utf-8");
      sections.push(`--- @${filePath} ---\n${content}\n--- end @${filePath} ---`);
    } catch (err: any) {
      sections.push(`--- @${filePath} skipped: ${err.message ?? err} ---`);
    }
  }

  return `${text}\n\nAttached file context from @ mentions:\n${sections.join("\n\n")}`;
}

/**
 * Read multi-line input from stdin with project-file mentions.
 * Type @ to open the file picker, filter by path, then press Enter/Tab to insert.
 */
async function ask(prompt: string): Promise<string> {
  const projectFiles = await getProjectFiles();

  return new Promise((resolve) => {
    const lines: string[] = [""];
    const cursor: CursorPos = { line: 0, col: 0 };
    const wasRaw = input.isRaw;
    let lastRenderRows = 1;
    let selectedSuggestion = 0;
    let closedMentionKey: string | undefined;

    const cols = () => process.stdout.columns ?? 80;

    const mentionState = () => {
      const mention = activeMention(lines, cursor);
      const key = mention ? `${mention.line}:${mention.startCol}` : undefined;
      if (key && key === closedMentionKey) return { mention: undefined, suggestions: [] };
      const suggestions = findMentionSuggestions(projectFiles, mention);
      if (selectedSuggestion >= suggestions.length) selectedSuggestion = 0;
      return { mention, suggestions };
    };

    const render = () => {
      const width = cols();
      const { mention, suggestions } = mentionState();
      const screenLines = [prompt + (lines[0] ?? ""), ...lines.slice(1)];

      if (mention) {
        const title = suggestions.length
          ? `${DIM} @ files (${mention.query || "type to filter"})${RESET}`
          : `${DIM} @ files: no matches${RESET}`;
        screenLines.push(title);
        suggestions.forEach((file, idx) => {
          const marker = idx === selectedSuggestion ? `${CYAN}›${RESET}` : " ";
          const dir = file.directory ? `${DIM} ${file.directory}${RESET}` : "";
          screenLines.push(`${marker} ${file.name}${dir}`);
        });
        if (suggestions.length) {
          screenLines.push(`${DIM} Enter/Tab select · Esc close · ↑/↓ navigate${RESET}`);
        }
      }

      for (let i = 0; i < lastRenderRows - 1; i++) output.write("\x1b[A");
      output.write("\r\x1b[J");
      output.write(screenLines.join("\n"));

      const visualLineRows = screenLines.map((line) => visualRows(line, width));
      lastRenderRows = visualLineRows.reduce((sum, rowCount) => sum + rowCount, 0);

      const promptLen = stripAnsi(prompt).length;
      let targetVisualRow = 0;
      for (let i = 0; i < cursor.line; i++) {
        targetVisualRow += visualRows(i === 0 ? prompt + (lines[0] ?? "") : lines[i] ?? "", width);
      }
      const cursorColWithPrompt = (cursor.line === 0 ? promptLen : 0) + cursor.col;
      targetVisualRow += Math.floor(cursorColWithPrompt / width);
      const targetCol = (cursorColWithPrompt % width) + 1;

      const currentVisualRow = lastRenderRows - 1;
      const rowsUp = currentVisualRow - targetVisualRow;
      if (rowsUp > 0) {
        for (let i = 0; i < rowsUp; i++) output.write("\x1b[A");
      }
      output.write(`\x1b[${targetCol}G`);
    };

    const closeMention = () => {
      const mention = activeMention(lines, cursor);
      closedMentionKey = mention ? `${mention.line}:${mention.startCol}` : undefined;
      selectedSuggestion = 0;
    };

    const acceptSuggestion = (): boolean => {
      const { mention, suggestions } = mentionState();
      if (!mention || !suggestions.length) return false;
      insertMention(lines, cursor, mention, suggestions[selectedSuggestion]!.path);
      closedMentionKey = undefined;
      selectedSuggestion = 0;
      return true;
    };

    const insertText = (text: string) => {
      const line = lines[cursor.line] ?? "";
      lines[cursor.line] = line.slice(0, cursor.col) + text + line.slice(cursor.col);
      cursor.col += text.length;
      closedMentionKey = undefined;
    };

    const splitLine = () => {
      const line = lines[cursor.line] ?? "";
      const before = line.slice(0, cursor.col);
      const after = line.slice(cursor.col);
      lines[cursor.line] = before;
      lines.splice(cursor.line + 1, 0, after);
      cursor.line++;
      cursor.col = 0;
      closedMentionKey = undefined;
    };

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(wasRaw ?? false);
      input.pause();
    };

    // ---- history navigation helpers (defined inside ask) ----
    const navigateHistory = (direction: "up" | "down") => {
      if (inputHistory.length === 0) return;
      const { mention } = mentionState();
      if (mention) return; // don't steal arrows from mention picker

      // Only allow history navigation from the very start/end of the whole buffer
      const isAtStart = cursor.line === 0 && cursor.col === 0;
      const lastLineIdx = lines.length - 1;
      const lastLine = lines[lastLineIdx] ?? "";
      const isAtEnd = cursor.line === lastLineIdx && cursor.col === lastLine.length;

      if (direction === "up" && !isAtStart) return;
      if (direction === "down" && !isAtEnd) return;

      if (direction === "up") {
        if (historyCursor === -1) {
          // Save current draft before moving into history
          savedInputBeforeHistory = lines.join("\n");
          historyCursor = inputHistory.length - 1;
        } else if (historyCursor > 0) {
          historyCursor--;
        } else {
          return; // already at oldest
        }
      } else {
        // down
        if (historyCursor === -1) return;
        if (historyCursor < inputHistory.length - 1) {
          historyCursor++;
        } else {
          // back to original draft
          historyCursor = -1;
          const restored = savedInputBeforeHistory ?? "";
          savedInputBeforeHistory = null;
          const restoredLines = restored.split("\n");
          lines.length = 0;
          for (const l of restoredLines) lines.push(l);
          cursor.line = lines.length - 1;
          cursor.col = (lines[cursor.line] ?? "").length;
          return;
        }
      }

      // Apply history entry
      const entry = inputHistory[historyCursor]!;
      const entryLines = entry.split("\n");
      lines.length = 0;
      for (const l of entryLines) lines.push(l);
      cursor.line = lines.length - 1;
      cursor.col = (lines[cursor.line] ?? "").length;
    };

    const onKeypress = (str: string | undefined, key: any) => {
      if (!key) return;
      const { mention, suggestions } = mentionState();

      if (mention && key.name === "tab") {
        if (acceptSuggestion()) render();
        return;
      }

      if (key.name === "return") {
        if (mention && suggestions.length) {
          acceptSuggestion();
          render();
        } else if (key.shift) {
          splitLine();
          render();
        } else {
          cleanup();
          output.write("\n");
          resolve(lines.join("\n"));
        }
        return;
      }

      if (mention && key.name === "escape") {
        closeMention();
        render();
        return;
      }

      if (mention && suggestions.length && (key.name === "up" || key.name === "down")) {
        selectedSuggestion =
          key.name === "up"
            ? (selectedSuggestion - 1 + suggestions.length) % suggestions.length
            : (selectedSuggestion + 1) % suggestions.length;
        render();
        return;
      }

      if (key.name === "backspace") {
        if (cursor.col > 0) {
          const line = lines[cursor.line] ?? "";
          lines[cursor.line] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
          cursor.col--;
          closedMentionKey = undefined;
        } else if (cursor.line > 0) {
          const prev = lines[cursor.line - 1] ?? "";
          const cur = lines[cursor.line] ?? "";
          cursor.col = prev.length;
          lines[cursor.line - 1] = prev + cur;
          lines.splice(cursor.line, 1);
          cursor.line--;
          closedMentionKey = undefined;
        }
      } else if (key.name === "delete") {
        const line = lines[cursor.line] ?? "";
        if (cursor.col < line.length) {
          lines[cursor.line] = line.slice(0, cursor.col) + line.slice(cursor.col + 1);
        } else if (cursor.line < lines.length - 1) {
          lines[cursor.line] = line + (lines[cursor.line + 1] ?? "");
          lines.splice(cursor.line + 1, 1);
        }
        closedMentionKey = undefined;
      } else if (key.name === "left") {
        if (cursor.col > 0) cursor.col--;
        else if (cursor.line > 0) {
          cursor.line--;
          cursor.col = (lines[cursor.line] ?? "").length;
        }
      } else if (key.name === "right") {
        const line = lines[cursor.line] ?? "";
        if (cursor.col < line.length) cursor.col++;
        else if (cursor.line < lines.length - 1) {
          cursor.line++;
          cursor.col = 0;
        }
      } else if (key.name === "up") {
        const { mention } = mentionState();
        if (mention && suggestions.length) {
          selectedSuggestion =
            (selectedSuggestion - 1 + suggestions.length) % suggestions.length;
        } else if (cursor.line === 0 && cursor.col === 0) {
          navigateHistory("up");
        } else if (cursor.line > 0) {
          cursor.line--;
          cursor.col = Math.min(cursor.col, (lines[cursor.line] ?? "").length);
        }
      } else if (key.name === "down") {
        const { mention } = mentionState();
        if (mention && suggestions.length) {
          selectedSuggestion = (selectedSuggestion + 1) % suggestions.length;
        } else if (
          cursor.line === lines.length - 1 &&
          cursor.col === (lines[cursor.line] ?? "").length
        ) {
          navigateHistory("down");
        } else if (cursor.line < lines.length - 1) {
          cursor.line++;
          cursor.col = Math.min(cursor.col, (lines[cursor.line] ?? "").length);
        }
      } else if (key.name === "home") {
        cursor.col = 0;
      } else if (key.name === "end") {
        cursor.col = (lines[cursor.line] ?? "").length;
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        process.exit(0);
      } else if (key.ctrl && key.name === "d") {
        cleanup();
        output.write("\n");
        resolve("");
        return;
      } else if (key.ctrl && key.name === "l") {
        output.write("\x1b[2J\x1b[H");
        lastRenderRows = 1;
      } else if (str && !key.ctrl && !key.meta) {
        insertText(str);
      }

      render();
    };

    input.setRawMode(true);
    input.resume();
    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    render();
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
  const systemPrompt = `cwd: ${CWD}.
  You are a precise coding assistant. Understand the user's request, gather context with tools, and deliver concrete, correct results.
  
  When you need to generate or change code:
   • For a single file, use **ollama_code** with a concrete **file_path**.
   • For multiple files, use **ollama_batch** with a **tasks** array.
   • These tools write files directly – you do NOT need to call write/edit afterwards.
   • After the tool returns "ok: ...", assume the change succeeded.
   • After the tool succeeds, reply with a brief summary.
  
  When you need to investigate, use read/glob/grep/bash freely.
  
  IMPORTANT – performance rule:
   • Do NOT make parallel independent tool calls in the same turn.
   • Use sequential tool calls only when the output of one is required for the next.
  
  ## Agent Swarm
  
  You can orchestrate multiple specialized agents for complex tasks:
  
  - Use **swarm_plan** to create a structured execution plan
  - Use **swarm_invoke** to delegate subtasks to specialist agents
  - Use **swarm_broadcast** to share context across all agents
  
  Available agents are defined in .archie/agents/*.md files. Each agent has:
  - Specialized capabilities and tools
  - A system prompt defining its expertise
  - Routing rules for automatic task assignment
  
  When a task requires multiple skills (e.g., coding + testing + review),
  prefer using the swarm tools over doing everything yourself.
  
  For quick swarm execution, users can also use CLI commands:
  - /swarm <pattern> <agents> <task>
  - /route <task> — see which agents match
  
  Use the **memory** tool to remember important information proactively.
  
  After any tool response, reply concisely and wait for the user's next instruction.`;

  let sessionCount = 1;
  const promptStr = () => `${BOLD}${CYAN}${path.basename(CWD)}${RESET} ${BLUE}#${sessionCount}${RESET} ${BOLD}${BLUE}❯${RESET} `;

  while (true) {
    try {
      console.log(separator());
      const userInput = await ask(promptStr());
      console.log(separator());
      const trimmed = userInput.trim();
      if (!trimmed) continue;
      if (trimmed === "/q" || trimmed === "exit") break;
      // -- history management --
      if (trimmed && inputHistory[inputHistory.length - 1] !== trimmed) {
        inputHistory.push(trimmed);
      }
      historyCursor = -1;
      savedInputBeforeHistory = null;
      if (trimmed === "/c" || trimmed === "/new") {
        messages.length = 0;
        sessionCount++;
        console.log(
          `\n${BOLD}nanocode${RESET} | ${DIM}${MODEL}${RESET} | ${BOLD}${CYAN}${path.basename(CWD)}${RESET}\n`
        );
        continue;
      }
      if (trimmed === "/help") {
        console.log(
          `${GREEN}Commands:${RESET}
        /c, /new    – start a fresh conversation
        /q, exit    – quit
        /init       – analyze codebase and create/improve AGENTS.md
        /help       – show this help
      
      ${GREEN}Swarm Commands:${RESET}
        /agents, /swarm list          – list available agents
        /agent <id>                   – show agent details
        /swarm [pattern] [agents] <task>  – run task with agent swarm
        /route <task>                 – analyze which agents would handle a task
      
        Examples:
          /swarm supervisor coder,reviewer implement auth
          /swarm pipeline planner,coder,tester build API
          /swarm swarm all brainstorm naming
          /swarm map-reduce coder,coder,coder refactor
      
      ${GREEN}Tools (called by the assistant automatically):${RESET}
        read, write, edit, glob, grep, bash, ollama_code, memory,
        swarm_invoke, swarm_broadcast, swarm_plan
      
      ${GREEN}Input features:${RESET}
        @filename   – fuzzy file picker (type @, arrows, Tab/Enter)
        Up/Down     – command history (when cursor at very start/end)
        Shift+Enter – insert newline
        Ctrl+C      – quit
        Ctrl+D      – cancel input
        Ctrl+L      – clear screen`
        );
        continue;
      }

      if (trimmed === "/init") {
        // add to history
        if (inputHistory[inputHistory.length - 1] !== trimmed) {
          inputHistory.push(trimmed);
        }
        historyCursor = -1;
        savedInputBeforeHistory = null;

        const initPrompt = `Please analyze this codebase and create a AGENTS.md file, which will be given to future instances of archiecoder to operate in this repository.

What to add:
1. Commands that will be commonly used, such as how to build, lint, and run tests. Include the necessary commands to develop in this codebase, such as how to run a single test.
2. High-level code architecture and structure so that future instances can be productive more quickly. Focus on the "big picture" architecture that requires reading multiple files to understand.

Usage notes:
- If there's already a AGENTS.md, suggest improvements to it.
- When you make the initial AGENTS.md, do not repeat yourself and do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information (API keys, tokens) in code or commits".
- Avoid listing every component or file structure that can be easily discovered.
- Don't include generic development practices.
- If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), make sure to include the important parts.
- If there is a README.md, make sure to include the important parts.
- Do not make up information such as "Common Development Tasks", "Tips for Development", "Support and Documentation" unless this is expressly included in other files that you read.
- Be sure to prefix the file with the following text:

\`\`\`
# AGENTS.md

This file provides guidance to archiecode when working with code in this repository.
\`\`\``;

        messages.push({ role: "user", content: initPrompt });
        // fall through to the agent turn loop (no `continue`)
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // SWARM COMMANDS
      // ═══════════════════════════════════════════════════════════════════════════

      if (trimmed === "/agents" || trimmed === "/swarm list") {
        await swarmCLI.init();
        console.log("\n" + (await swarmCLI.listAgents()) + "\n");
        continue;
      }

      if (trimmed.startsWith("/agent ")) {
        await swarmCLI.init();
        const id = trimmed.slice(7).trim();
        console.log("\n" + (await swarmCLI.showAgent(id)) + "\n");
        continue;
      }

      if (trimmed.startsWith("/swarm ")) {
        await swarmCLI.init();
        const args = trimmed.slice(6).trim();

        // Parse: /swarm [pattern] [agent1,agent2,...] <task>
        const parts = args.split(" ");
        let pattern: SwarmPattern = "supervisor";
        let agentIds: string[] | undefined;
        let taskStart = 0;

        const possiblePatterns: SwarmPattern[] = ["supervisor", "pipeline", "swarm", "map-reduce"];
        if (possiblePatterns.includes(parts[0] as SwarmPattern)) {
          pattern = parts[0] as SwarmPattern;
          taskStart = 1;
        }

        if (parts[taskStart]?.includes(",")) {
          const ids = parts[taskStart].split(",").map((s) => s.trim());
          agentIds = ids[0] === "all" ? ["all"] : ids;
          taskStart++;
        }

        const task = parts.slice(taskStart).join(" ");
        if (!task) {
          console.log(`${RED}Usage: /swarm [pattern] [agent1,agent2,...] <task>${RESET}`);
          console.log(`${DIM}Patterns: supervisor, pipeline, swarm, map-reduce${RESET}`);
          continue;
        }

        console.log(await swarmCLI.run(task, pattern, agentIds));
        continue;
      }

      if (trimmed.startsWith("/route ")) {
        await swarmCLI.init();
        const task = trimmed.slice(7).trim();
        console.log("\n" + (await swarmCLI.route(task)) + "\n");
        continue;
      }

      if (trimmed !== "/init") {
        messages.push({ role: "user", content: await buildMentionContext(trimmed) });
      }

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
              `\n${GREEN}⏺ ${(toolName[0] ?? "").toUpperCase() + toolName.slice(1)}${RESET}(${DIM}${previewArg}${RESET})`
            );

            const result = await runTool(toolName, toolArgs);
            const resultLines = result.split("\n");
            let preview = (resultLines[0] ?? "").slice(0, 60);
            if (resultLines.length > 1)
              preview += ` ... +${resultLines.length - 1} lines`;
            else if ((resultLines[0] ?? "").length > 60) preview += "...";
            console.log(`  ${DIM}⎿  ${preview}${RESET}`);

            if (toolName === "ollama_code" && result && !result.startsWith("Error")) {
              console.log(`\n${YELLOW}── ollama_code output ──${RESET}`);
              console.log(result);
              console.log(`${YELLOW}── end of output ──${RESET}`);
            } else if (toolName === "ollama_batch" && result && !result.startsWith("Error")) {
              console.log(`\n${YELLOW}── batch result ──${RESET}`);
              console.log(result);
              console.log(`${YELLOW}── end of batch ──${RESET}`);
            }

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
