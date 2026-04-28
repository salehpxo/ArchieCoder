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
import * as readline from "node:readline";
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

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 8192,
    messages: wireMessages,
    tools: makeToolDefinitions(),
  });

  const response = await fetch(API_URL, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
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

async function main() {
  console.log(
    `${BOLD}nanocode${RESET} | ${DIM}${MODEL} | ${CWD}${RESET} | ${YELLOW}node src/index.ts${RESET}\n`
  );

  const rl = readline.createInterface({ input, output, prompt: "" });
  const messages: Message[] = [];
  const systemPrompt = `Concise coding assistant. cwd: ${CWD}.`;

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question(`${BOLD}${BLUE}❯${RESET} `, (answer) =>
        resolve(answer.trim())
      );
    });

  while (true) {
    try {
      console.log(separator());
      const userInput = await ask();
      console.log(separator());
      if (!userInput) continue;
      if (userInput === "/q" || userInput === "exit") break;
      if (userInput === "/c") {
        messages.length = 0;
        console.log(`${GREEN}⏺ Cleared conversation${RESET}`);
        continue;
      }

      messages.push({ role: "user", content: userInput });

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

  rl.close();
}

main().catch(console.error);