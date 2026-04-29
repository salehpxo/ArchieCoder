#!/usr/bin/env -S npx tsx
/**
 * swarm.ts — Agent Swarm Orchestration for nanocode
 *
 * Architecture: Hierarchical Supervisor with Peer-to-Peer Handoffs
 * Each agent is a .md file in .archie/agents/ with YAML frontmatter.
 *
 * Patterns supported:
 *   - supervisor: Central orchestrator delegates to specialists
 *   - pipeline:   Sequential agent chain (A → B → C)
 *   - swarm:      Peer-to-peer collaboration with shared context
 *   - map-reduce: Parallel execution with result aggregation
 */

import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// Re-use ANSI codes from main file (they are module-level there)
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentRoutingRule {
  pattern: string;
  weight: number;
}

interface AgentBehavior {
  auto_verify?: boolean;
  max_iterations?: number;
  parallel_safe?: boolean;
}

interface AgentMemory {
  scope: "project" | "session" | "agent";
  keys?: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  model?: string;
  provider?: string;
  temperature?: number;
  max_tokens?: number;
  capabilities: string[];
  tools: string[];
  patterns: ("hierarchical" | "peer" | "pipeline" | "swarm")[];
  routing?: {
    triggers?: AgentRoutingRule[];
    exclusions?: AgentRoutingRule[];
  };
  behavior?: AgentBehavior;
  dependencies?: string[];
  memory?: AgentMemory;
  systemPrompt: string;
  sourcePath: string;
}

export interface SwarmMessage {
  id: string;
  from: string;        // agent id or "user" or "orchestrator"
  to: string;          // agent id or "broadcast" or "orchestrator"
  type: "task" | "result" | "handoff" | "broadcast" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

interface SwarmAgentState {
  agentId: string;
  status: "idle" | "working" | "done" | "error";
  currentTask?: string;
  output?: string;
  artifacts: string[];
  error?: string;
  startTime?: number;
  endTime?: number;
}

interface SwarmState {
  sessionId: string;
  task: string;
  pattern: SwarmPattern;
  plan?: {
    steps: string[];
    currentStep: number;
    status: "planning" | "in_progress" | "completed" | "failed";
  };
  agents: Record<string, SwarmAgentState>;
  messages: SwarmMessage[];
  artifacts: {
    files: Record<string, string>;
    notes: string[];
  };
  context: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export type SwarmPattern = "supervisor" | "pipeline" | "swarm" | "map-reduce";

interface SwarmConfig {
  agentsDir: string;
  stateDir: string;
  maxConcurrentAgents: number;
  defaultPattern: SwarmPattern;
  timeoutMs: number;
  enableTrace: boolean;
}

export interface SwarmResult {
  success: boolean;
  output: string;
  artifacts: string[];
  agentOutputs: Record<string, string>;
  trace: SwarmMessage[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SWARM_DIR = path.join(process.cwd(), ".archie");
const AGENTS_DIR = path.join(SWARM_DIR, "agents");
const STATE_DIR = path.join(SWARM_DIR, "swarm-state");
const TRACE_DIR = path.join(SWARM_DIR, "swarm-traces");

const DEFAULT_CONFIG: SwarmConfig = {
  agentsDir: AGENTS_DIR,
  stateDir: STATE_DIR,
  maxConcurrentAgents: 4,
  defaultPattern: "supervisor",
  timeoutMs: 300_000,
  enableTrace: true,
};

// ---------------------------------------------------------------------------
// YAML Frontmatter Parser (lightweight, zero deps)
// ---------------------------------------------------------------------------

function parseYamlFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlText = match[1];
  const body = match[2].trim();
  const frontmatter: Record<string, any> = {};

  const lines = yamlText.split("\n");
  let currentKey = "";
  let inArray = false;
  let arrayItems: string[] = [];
  let inObject = false;
  let objectBuffer: Record<string, any> = {};

  function flushArray() {
    if (inArray && arrayItems.length > 0) {
      frontmatter[currentKey] = arrayItems;
    }
    inArray = false;
    arrayItems = [];
  }

  function flushObject() {
    if (inObject && Object.keys(objectBuffer).length > 0) {
      if (!frontmatter[currentKey]) frontmatter[currentKey] = {};
      Object.assign(frontmatter[currentKey], objectBuffer);
    }
    inObject = false;
    objectBuffer = {};
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      flushArray();
      flushObject();
      continue;
    }

    // Array item
    if (trimmed.startsWith("- ")) {
      if (!inArray && !inObject) {
        inArray = true;
      }
      if (inArray) {
        arrayItems.push(trimmed.slice(2).trim());
        continue;
      }
    }

    // Object property (indented key: value)
    const objMatch = line.match(/^(\s+)(\w+):\s*(.*)$/);
    if (objMatch && (inArray || inObject || currentKey)) {
      const [, indent, key, val] = objMatch;
      if (inArray) {
        // Convert last array item to object if it looks like one
        const lastItem = arrayItems[arrayItems.length - 1];
        if (lastItem && !lastItem.includes(":") && indent.length > 0) {
          arrayItems.pop();
          if (!frontmatter[currentKey]) frontmatter[currentKey] = [];
          const arr = frontmatter[currentKey] as any[];
          const lastObj = arr[arr.length - 1];
          if (lastObj && typeof lastObj === "object") {
            lastObj[key] = parseYamlValue(val);
          }
          continue;
        }
      }
      inObject = true;
      objectBuffer[key] = parseYamlValue(val);
      continue;
    }

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      flushArray();
      flushObject();
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();

      if (val === "" || val === "[]" || val === "{}" || val === "null") {
        // Could be array or object start — defer
        frontmatter[currentKey] = [];
        inArray = true;
      } else {
        frontmatter[currentKey] = parseYamlValue(val);
      }
    }
  }

  flushArray();
  flushObject();

  return { frontmatter, body };
}

function parseYamlValue(val: string): any {
  if (val === "true" || val === "True") return true;
  if (val === "false" || val === "False") return false;
  if (val === "null" || val === "~") return null;
  if (/^-?\d+$/.test(val)) return parseInt(val);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  return val.replace(/^["']|["']$/g, "");
}

// ---------------------------------------------------------------------------
// Agent Registry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;

    if (!existsSync(AGENTS_DIR)) {
      await fs.mkdir(AGENTS_DIR, { recursive: true });
      await this.createDefaultAgents();
    }

    const files = await fs.readdir(AGENTS_DIR).catch(() => [] as string[]);

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = path.join(AGENTS_DIR, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const { frontmatter, body } = parseYamlFrontmatter(content);

        const id = frontmatter.id || path.basename(file, ".md");

        const agent: AgentDefinition = {
          id,
          name: frontmatter.name || id,
          description: frontmatter.description || "",
          model: frontmatter.model,
          provider: frontmatter.provider,
          temperature: frontmatter.temperature,
          max_tokens: frontmatter.max_tokens,
          capabilities: Array.isArray(frontmatter.capabilities)
            ? frontmatter.capabilities
            : [],
          tools: Array.isArray(frontmatter.tools)
            ? frontmatter.tools
            : ["read", "write", "edit", "glob", "grep", "bash"],
          patterns: Array.isArray(frontmatter.patterns)
            ? frontmatter.patterns
            : ["hierarchical"],
          routing: frontmatter.routing,
          behavior: frontmatter.behavior,
          dependencies: Array.isArray(frontmatter.dependencies)
            ? frontmatter.dependencies
            : [],
          memory: frontmatter.memory,
          systemPrompt: body,
          sourcePath: filePath,
        };

        this.agents.set(id, agent);
      } catch (err: any) {
        console.warn(`${YELLOW}⚠ Failed to load agent ${file}: ${err.message}${RESET}`);
      }
    }

    this.loaded = true;
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  findByCapability(capability: string): AgentDefinition[] {
    return this.getAll().filter((a) => a.capabilities.includes(capability));
  }

  findByPattern(pattern: SwarmPattern): AgentDefinition[] {
    return this.getAll().filter((a) => a.patterns.includes(pattern as any));
  }

  /**
   * Score agents by relevance to a task description.
   * Uses routing rules (triggers/exclusions) + capability matching.
   */
  scoreAgents(task: string): { agent: AgentDefinition; score: number }[] {
    const scored = this.getAll().map((agent) => {
      let score = 0;
      const taskLower = task.toLowerCase();

      // Routing triggers
      if (agent.routing?.triggers) {
        for (const rule of agent.routing.triggers) {
          try {
            const regex = new RegExp(rule.pattern, "i");
            if (regex.test(task)) {
              score += rule.weight * 100;
            }
          } catch {
            // invalid regex, skip
          }
        }
      }

      // Routing exclusions
      if (agent.routing?.exclusions) {
        for (const rule of agent.routing.exclusions) {
          try {
            const regex = new RegExp(rule.pattern, "i");
            if (regex.test(task)) {
              score += rule.weight * 100;
            }
          } catch {
            // invalid regex, skip
          }
        }
      }

      // Capability overlap
      for (const cap of agent.capabilities) {
        if (taskLower.includes(cap.toLowerCase())) {
          score += 10;
        }
      }

      // Description overlap
      const descWords = agent.description.toLowerCase().split(/\s+/);
      for (const word of descWords) {
        if (word.length > 3 && taskLower.includes(word)) {
          score += 5;
        }
      }

      return { agent, score };
    });

    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  }

  private async createDefaultAgents(): Promise<void> {
    const defaultAgents = [
      {
        filename: "planner.md",
        content: `---
id: "planner"
name: "Task Planner"
description: "Breaks down complex tasks into actionable steps and assigns them to the right specialists"
capabilities:
  - "planning"
  - "analysis"
  - "task-decomposition"
patterns:
  - "hierarchical"
  - "pipeline"
tools:
  - "read"
  - "glob"
  - "grep"
  - "bash"
routing:
  triggers:
    - pattern: "(?i)\\b(plan|design|architecture|break down|steps)\\b"
      weight: 1.0
behavior:
  parallel_safe: false
---

You are a strategic task planner. Your job is to analyze complex requests and break them into clear, actionable steps.

## Responsibilities
1. Analyze the user's request and identify all subtasks
2. Determine the optimal execution order (dependencies)
3. Assign each subtask to the most appropriate specialist agent
4. Define success criteria for each step

## Output Format
Always respond with a structured plan:

\`\`\`plan
Pattern: <supervisor|pipeline|swarm|map-reduce>
Steps:
1. [Agent: <agent-id>] <Task description> — Success: <criteria>
2. [Agent: <agent-id>] <Task description> — Success: <criteria>
...

Parallel Groups:
- Group 1: [step-1, step-2] (no dependencies)
- Group 2: [step-3] (depends on Group 1)

Final Deliverable: <what the user expects>
\`\`\`
`,
      },
      {
        filename: "coder.md",
        content: `---
id: "coder"
name: "Code Specialist"
description: "Writes, edits, and refactors code across languages. Expert in clean code and best practices."
capabilities:
  - "coding"
  - "refactoring"
  - "debugging"
  - "typescript"
  - "javascript"
  - "python"
patterns:
  - "hierarchical"
  - "peer"
  - "pipeline"
tools:
  - "read"
  - "write"
  - "edit"
  - "glob"
  - "grep"
  - "bash"
  - "ollama_code"
routing:
  triggers:
    - pattern: "(?i)\\b(code|implement|write|create|function|class|refactor|fix bug)\\b"
      weight: 1.0
    - pattern: "(?i)\\b(typescript|javascript|python|rust|go)\\b"
      weight: 0.9
behavior:
  auto_verify: true
  max_iterations: 3
  parallel_safe: true
dependencies:
  - "test-engineer"
  - "reviewer"
---

You are an expert software engineer. You write clean, maintainable, and well-tested code.

## Core Principles
- Write code that is self-documenting
- Follow existing project conventions
- Prefer explicit over implicit
- Handle edge cases gracefully

## Workflow
1. Read relevant files to understand context
2. Implement the requested changes
3. Run any available tests or linting
4. If tests fail, fix them
5. Summarize what was changed

## When to Delegate
- Need tests? → @test-engineer
- Need review? → @reviewer
- Need docs? → @docs-writer
`,
      },
      {
        filename: "reviewer.md",
        content: `---
id: "reviewer"
name: "Code Reviewer"
description: "Reviews code for quality, security, performance, and adherence to best practices"
capabilities:
  - "code-review"
  - "security"
  - "performance"
  - "best-practices"
patterns:
  - "pipeline"
  - "hierarchical"
tools:
  - "read"
  - "glob"
  - "grep"
  - "bash"
routing:
  triggers:
    - pattern: "(?i)\\b(review|audit|check|quality|security|performance)\\b"
      weight: 1.0
behavior:
  parallel_safe: true
---

You are a meticulous code reviewer. You catch bugs, security issues, and maintainability problems.

## Review Checklist
- [ ] Correctness: Does the code do what it claims?
- [ ] Security: Any injection risks, leaks, or vulnerabilities?
- [ ] Performance: Any obvious bottlenecks or N+1 issues?
- [ ] Maintainability: Is it readable and well-structured?
- [ ] Testing: Are edge cases covered?
- [ ] Consistency: Does it follow project conventions?

## Output Format
Provide a structured review:

**Summary**: <overall assessment>
**Issues**: <list of problems with severity>
**Suggestions**: <improvements>
**Approval**: <approved / changes_requested>
`,
      },
      {
        filename: "test-engineer.md",
        content: `---
id: "test-engineer"
name: "Test Engineer"
description: "Writes comprehensive tests, sets up test infrastructure, and ensures code quality through testing"
capabilities:
  - "testing"
  - "jest"
  - "vitest"
  - "playwright"
  - "unit-tests"
  - "integration-tests"
patterns:
  - "pipeline"
  - "hierarchical"
tools:
  - "read"
  - "write"
  - "edit"
  - "glob"
  - "grep"
  - "bash"
routing:
  triggers:
    - pattern: "(?i)\\b(test|spec|jest|vitest|playwright|cypress|coverage)\\b"
      weight: 1.0
behavior:
  parallel_safe: true
---

You are a test automation specialist. You write thorough tests that catch regressions and document behavior.

## Testing Philosophy
- Test behavior, not implementation
- Cover happy path, edge cases, and error cases
- Keep tests fast and deterministic
- Use descriptive test names

## Workflow
1. Read the code to be tested
2. Identify test scenarios (happy path, edge cases, errors)
3. Write tests using the project's testing framework
4. Run tests to verify they pass
5. Report coverage and any gaps
`,
      },
      {
        filename: "docs-writer.md",
        content: `---
id: "docs-writer"
name: "Documentation Specialist"
description: "Writes clear documentation, READMEs, API docs, and inline comments"
capabilities:
  - "documentation"
  - "technical-writing"
  - "markdown"
patterns:
  - "pipeline"
  - "hierarchical"
tools:
  - "read"
  - "write"
  - "edit"
  - "glob"
routing:
  triggers:
    - pattern: "(?i)\\b(doc|document|readme|guide|tutorial|comment)\\b"
      weight: 1.0
behavior:
  parallel_safe: true
---

You are a technical writer who makes complex topics accessible.

## Documentation Principles
- Start with the "why", then "what", then "how"
- Use examples liberally
- Keep it concise but complete
- Update existing docs rather than duplicating

## Output Format
- README sections: Overview, Installation, Usage, API, Contributing
- Code docs: JSDoc/TSDoc for public APIs
- Guides: Step-by-step with clear headings
`,
      },
    ];

    for (const agent of defaultAgents) {
      const filePath = path.join(AGENTS_DIR, agent.filename);
      if (!existsSync(filePath)) {
        await fs.writeFile(filePath, agent.content, "utf-8");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Swarm State Manager
// ---------------------------------------------------------------------------

export class SwarmStateManager {
  private state: SwarmState | null = null;
  private stateFile: string;

  constructor(sessionId?: string) {
    const id = sessionId || randomUUID();
    this.stateFile = path.join(STATE_DIR, `${id}.json`);
  }

  async init(task: string, pattern: SwarmPattern, agents: string[]): Promise<SwarmState> {
    await fs.mkdir(STATE_DIR, { recursive: true });

    const now = Date.now();
    this.state = {
      sessionId: path.basename(this.stateFile, ".json"),
      task,
      pattern,
      agents: {},
      messages: [],
      artifacts: { files: {}, notes: [] },
      context: {},
      createdAt: now,
      updatedAt: now,
    };

    for (const agentId of agents) {
      this.state.agents[agentId] = {
        agentId,
        status: "idle",
        artifacts: [],
      };
    }

    await this.persist();
    return this.state;
  }

  async load(): Promise<SwarmState | null> {
    if (this.state) return this.state;
    if (!existsSync(this.stateFile)) return null;

    try {
      const data = await fs.readFile(this.stateFile, "utf-8");
      this.state = JSON.parse(data);
      return this.state;
    } catch {
      return null;
    }
  }

  async persist(): Promise<void> {
    if (!this.state) return;
    this.state.updatedAt = Date.now();
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
  }

  getState(): SwarmState | null {
    return this.state;
  }

  async addMessage(message: SwarmMessage): Promise<void> {
    if (!this.state) return;
    this.state.messages.push(message);
    await this.persist();
  }

  async updateAgentState(agentId: string, updates: Partial<SwarmAgentState>): Promise<void> {
    if (!this.state) return;
    if (!this.state.agents[agentId]) {
      this.state.agents[agentId] = {
        agentId,
        status: "idle",
        artifacts: [],
        ...updates,
      };
    } else {
      Object.assign(this.state.agents[agentId], updates);
    }
    await this.persist();
  }

  async addArtifact(filePath: string, content: string): Promise<void> {
    if (!this.state) return;
    this.state.artifacts.files[filePath] = content;
    await this.persist();
  }

  async addNote(note: string): Promise<void> {
    if (!this.state) return;
    this.state.artifacts.notes.push(note);
    await this.persist();
  }

  async setPlan(plan: SwarmState["plan"]): Promise<void> {
    if (!this.state) return;
    this.state.plan = plan;
    await this.persist();
  }

  async setContext(key: string, value: any): Promise<void> {
    if (!this.state) return;
    this.state.context[key] = value;
    await this.persist();
  }
}

// ---------------------------------------------------------------------------
// Swarm Orchestrator
// ---------------------------------------------------------------------------

export class SwarmOrchestrator {
  private registry: AgentRegistry;
  private config: SwarmConfig;

  constructor(registry: AgentRegistry, config: Partial<SwarmConfig> = {}) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main entry point: execute a task using the swarm
   */
  async execute(
    task: string,
    pattern?: SwarmPattern,
    agentIds?: string[]
  ): Promise<SwarmResult> {
    const startTime = Date.now();
    const selectedPattern = pattern || this.config.defaultPattern;

    // Determine which agents to use
    let selectedAgents: AgentDefinition[];
    if (agentIds && agentIds.length > 0) {
      if (agentIds.length === 1 && agentIds[0] === "all") {
        selectedAgents = this.registry.getAll();
      } else {
        selectedAgents = agentIds
          .map((id) => this.registry.get(id))
          .filter((a): a is AgentDefinition => !!a);
      }
    } else {
      // Auto-select based on task relevance
      const scored = this.registry.scoreAgents(task);
      selectedAgents = scored.slice(0, this.config.maxConcurrentAgents).map((s) => s.agent);
    }

    if (selectedAgents.length === 0) {
      return {
        success: false,
        output:
          "No suitable agents found for this task. Try creating a specialist agent in .archie/agents/",
        artifacts: [],
        agentOutputs: {},
        trace: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Initialize state
    const stateManager = new SwarmStateManager();
    const state = await stateManager.init(
      task,
      selectedPattern,
      selectedAgents.map((a) => a.id)
    );

    console.log(
      `\n${MAGENTA}╭── Swarm Session: ${state.sessionId}${RESET}`
    );
    console.log(`${MAGENTA}│ Pattern: ${selectedPattern}${RESET}`);
    console.log(
      `${MAGENTA}│ Agents: ${selectedAgents.map((a) => a.name).join(", ")}${RESET}`
    );
    console.log(
      `${MAGENTA}│ Task: ${task.slice(0, 60)}${task.length > 60 ? "..." : ""}${RESET}`
    );
    console.log(`${MAGENTA}╰${"─".repeat(50)}${RESET}\n`);

    // Execute based on pattern
    let result: SwarmResult;
    switch (selectedPattern) {
      case "supervisor":
        result = await this.executeSupervisor(task, selectedAgents, stateManager);
        break;
      case "pipeline":
        result = await this.executePipeline(task, selectedAgents, stateManager);
        break;
      case "swarm":
        result = await this.executeSwarm(task, selectedAgents, stateManager);
        break;
      case "map-reduce":
        result = await this.executeMapReduce(task, selectedAgents, stateManager);
        break;
      default:
        result = await this.executeSupervisor(task, selectedAgents, stateManager);
    }

    result.durationMs = Date.now() - startTime;

    // Save trace
    if (this.config.enableTrace) {
      await this.saveTrace(state.sessionId, result);
    }

    return result;
  }

  /**
   * SUPERVISOR PATTERN
   * One agent acts as the orchestrator, delegates to others, synthesizes results.
   */
  private async executeSupervisor(
    task: string,
    agents: AgentDefinition[],
    stateManager: SwarmStateManager
  ): Promise<SwarmResult> {
    const supervisor =
      agents.find((a) => a.capabilities.includes("planning")) || agents[0];
    const workers = agents.filter((a) => a.id !== supervisor.id);

    const agentOutputs: Record<string, string> = {};
    const trace: SwarmMessage[] = [];

    // Step 1: Supervisor creates a plan
    await stateManager.updateAgentState(supervisor.id, {
      status: "working",
      currentTask: "Creating execution plan",
      startTime: Date.now(),
    });

    console.log(`${CYAN}⏺ ${supervisor.name} is planning...${RESET}`);

    const plan = this.createSimulatedPlan(task, workers);
    await stateManager.setPlan({
      steps: plan.steps.map((s) => s.description),
      currentStep: 0,
      status: "in_progress",
    });

    await stateManager.updateAgentState(supervisor.id, {
      status: "done",
      endTime: Date.now(),
    });

    // Step 2: Execute plan steps
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const worker =
        workers.find((w) => w.id === step.agentId) || workers[i % workers.length];

      await stateManager.updateAgentState(worker.id, {
        status: "working",
        currentTask: step.description,
        startTime: Date.now(),
      });

      console.log(
        `${GREEN}⏺ ${worker.name} is working on: ${step.description}${RESET}`
      );

      const output = await this.simulateAgentWork(worker, step.description, task);
      agentOutputs[worker.id] = output;

      await stateManager.updateAgentState(worker.id, {
        status: "done",
        output,
        endTime: Date.now(),
      });

      const msg: SwarmMessage = {
        id: randomUUID(),
        from: supervisor.id,
        to: worker.id,
        type: "task",
        content: step.description,
        timestamp: Date.now(),
      };
      await stateManager.addMessage(msg);
      trace.push(msg);

      const resultMsg: SwarmMessage = {
        id: randomUUID(),
        from: worker.id,
        to: supervisor.id,
        type: "result",
        content: output,
        timestamp: Date.now(),
      };
      await stateManager.addMessage(resultMsg);
      trace.push(resultMsg);
    }

    // Step 3: Supervisor synthesizes final output
    console.log(
      `${CYAN}⏺ ${supervisor.name} is synthesizing results...${RESET}`
    );

    const finalOutput = this.synthesizeResults(task, agentOutputs);
    agentOutputs[supervisor.id] = finalOutput;

    return {
      success: true,
      output: finalOutput,
      artifacts: [],
      agentOutputs,
      trace,
      durationMs: 0,
    };
  }

  /**
   * PIPELINE PATTERN
   * Agents execute sequentially, each passing output to the next.
   */
  private async executePipeline(
    task: string,
    agents: AgentDefinition[],
    stateManager: SwarmStateManager
  ): Promise<SwarmResult> {
    const agentOutputs: Record<string, string> = {};
    const trace: SwarmMessage[] = [];
    let currentInput = task;

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const isLast = i === agents.length - 1;

      await stateManager.updateAgentState(agent.id, {
        status: "working",
        currentTask: `Pipeline step ${i + 1}/${agents.length}`,
        startTime: Date.now(),
      });

      console.log(
        `${GREEN}⏺ [${i + 1}/${agents.length}] ${agent.name} is processing...${RESET}`
      );

      const output = await this.simulateAgentWork(agent, currentInput, task);
      agentOutputs[agent.id] = output;
      currentInput = output;

      await stateManager.updateAgentState(agent.id, {
        status: "done",
        output,
        endTime: Date.now(),
      });

      if (!isLast) {
        const handoffMsg: SwarmMessage = {
          id: randomUUID(),
          from: agent.id,
          to: agents[i + 1].id,
          type: "handoff",
          content: output,
          timestamp: Date.now(),
        };
        await stateManager.addMessage(handoffMsg);
        trace.push(handoffMsg);
      }
    }

    return {
      success: true,
      output: currentInput,
      artifacts: [],
      agentOutputs,
      trace,
      durationMs: 0,
    };
  }

  /**
   * SWARM PATTERN
   * All agents work on the same task with shared context, then vote/synthesize.
   */
  private async executeSwarm(
    task: string,
    agents: AgentDefinition[],
    stateManager: SwarmStateManager
  ): Promise<SwarmResult> {
    const agentOutputs: Record<string, string> = {};
    const trace: SwarmMessage[] = [];

    console.log(
      `${MAGENTA}⏺ Swarm of ${agents.length} agents working in parallel...${RESET}`
    );

    const promises = agents.map(async (agent) => {
      await stateManager.updateAgentState(agent.id, {
        status: "working",
        currentTask: task,
        startTime: Date.now(),
      });

      const output = await this.simulateAgentWork(agent, task, task);
      agentOutputs[agent.id] = output;

      await stateManager.updateAgentState(agent.id, {
        status: "done",
        output,
        endTime: Date.now(),
      });

      const msg: SwarmMessage = {
        id: randomUUID(),
        from: agent.id,
        to: "broadcast",
        type: "broadcast",
        content: output,
        timestamp: Date.now(),
      };
      await stateManager.addMessage(msg);
      trace.push(msg);
    });

    await Promise.all(promises);

    const finalOutput = this.synthesizeResults(task, agentOutputs);

    return {
      success: true,
      output: finalOutput,
      artifacts: [],
      agentOutputs,
      trace,
      durationMs: 0,
    };
  }

  /**
   * MAP-REDUCE PATTERN
   * Split task into subtasks, execute in parallel, then reduce results.
   */
  private async executeMapReduce(
    task: string,
    agents: AgentDefinition[],
    stateManager: SwarmStateManager
  ): Promise<SwarmResult> {
    const agentOutputs: Record<string, string> = {};
    const trace: SwarmMessage[] = [];

    const subtasks = this.splitTask(task, agents.length);

    console.log(
      `${MAGENTA}⏺ Map phase: ${subtasks.length} subtasks across ${agents.length} agents${RESET}`
    );

    const mapPromises = agents.map(async (agent, i) => {
      const subtask = subtasks[i] || subtasks[subtasks.length - 1];

      await stateManager.updateAgentState(agent.id, {
        status: "working",
        currentTask: subtask,
        startTime: Date.now(),
      });

      const output = await this.simulateAgentWork(agent, subtask, task);
      agentOutputs[agent.id] = output;

      await stateManager.updateAgentState(agent.id, {
        status: "done",
        output,
        endTime: Date.now(),
      });

      const msg: SwarmMessage = {
        id: randomUUID(),
        from: agent.id,
        to: "orchestrator",
        type: "result",
        content: output,
        timestamp: Date.now(),
      };
      await stateManager.addMessage(msg);
      trace.push(msg);
    });

    await Promise.all(mapPromises);

    console.log(`${MAGENTA}⏺ Reduce phase: synthesizing results...${RESET}`);
    const finalOutput = this.synthesizeResults(task, agentOutputs);

    return {
      success: true,
      output: finalOutput,
      artifacts: [],
      agentOutputs,
      trace,
      durationMs: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private createSimulatedPlan(task: string, workers: AgentDefinition[]) {
    return {
      steps: workers.map((w, i) => ({
        agentId: w.id,
        description: `Step ${i + 1}: ${w.capabilities[0] || "task"} for "${task.slice(0, 40)}..."`,
      })),
    };
  }

  private splitTask(task: string, numParts: number): string[] {
    const parts: string[] = [];
    for (let i = 0; i < numParts; i++) {
      parts.push(`${task} (part ${i + 1}/${numParts})`);
    }
    return parts;
  }

  private async simulateAgentWork(
    agent: AgentDefinition,
    task: string,
    originalTask: string
  ): Promise<string> {
    // PLACEHOLDER: In production, this calls the LLM with agent's system prompt
    // and executes tool calls. See swarm-executor.ts for the real implementation.
    return `[${agent.name} output for: ${task.slice(0, 50)}...]`;
  }

  private synthesizeResults(task: string, outputs: Record<string, string>): string {
    const parts = Object.entries(outputs).map(([id, output]) => {
      const agent = this.registry.get(id);
      return `## ${agent?.name || id}\n${output}`;
    });

    return `# Swarm Results: ${task.slice(0, 50)}...\n\n${parts.join("\n\n")}`;
  }

  private async saveTrace(sessionId: string, result: SwarmResult): Promise<void> {
    await fs.mkdir(TRACE_DIR, { recursive: true });
    const traceFile = path.join(TRACE_DIR, `${sessionId}.json`);
    await fs.writeFile(traceFile, JSON.stringify(result, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// CLI Commands Integration
// ---------------------------------------------------------------------------

export class SwarmCLI {
  registry: AgentRegistry;
  private orchestrator: SwarmOrchestrator;

  constructor() {
    this.registry = new AgentRegistry();
    this.orchestrator = new SwarmOrchestrator(this.registry);
  }

  async init(): Promise<void> {
    await this.registry.load();
  }

  async listAgents(): Promise<string> {
    const agents = this.registry.getAll();
    if (agents.length === 0) {
      return "No agents found. Create .md files in .archie/agents/";
    }

    const lines = agents.map((a) => {
      const caps = a.capabilities.slice(0, 3).join(", ");
      const more = a.capabilities.length > 3 ? ` +${a.capabilities.length - 3}` : "";
      return `  ${GREEN}●${RESET} ${BOLD}${a.name}${RESET} (${DIM}${a.id}${RESET})\n    ${DIM}${a.description}${RESET}\n    ${DIM}Capabilities:${RESET} ${caps}${more} | ${DIM}Patterns:${RESET} ${a.patterns.join(", ")}`;
    });

    return `${BOLD}Available Agents (${agents.length}):${RESET}\n\n${lines.join("\n\n")}`;
  }

  async showAgent(id: string): Promise<string> {
    const agent = this.registry.get(id);
    if (!agent) return `Agent "${id}" not found.`;

    return `${BOLD}${agent.name}${RESET} (${agent.id})\n${DIM}${"─".repeat(40)}${RESET}\n\n${agent.description}\n\n${DIM}Capabilities:${RESET} ${agent.capabilities.join(", ")}\n${DIM}Tools:${RESET} ${agent.tools.join(", ")}\n${DIM}Patterns:${RESET} ${agent.patterns.join(", ")}\n${DIM}Source:${RESET} ${agent.sourcePath}\n\n${BOLD}System Prompt:${RESET}\n${agent.systemPrompt.slice(0, 500)}${agent.systemPrompt.length > 500 ? "..." : ""}`;
  }

  async run(task: string, pattern?: SwarmPattern, agentIds?: string[]): Promise<string> {
    const result = await this.orchestrator.execute(task, pattern, agentIds);

    if (!result.success) {
      return `${RED}✗ Swarm execution failed:${RESET} ${result.output}`;
    }

    const lines = [
      `${GREEN}✓ Swarm completed in ${(result.durationMs / 1000).toFixed(1)}s${RESET}`,
      "",
      `${BOLD}Final Output:${RESET}`,
      result.output,
      "",
      `${BOLD}Agent Contributions:${RESET}`,
    ];

    for (const [id, output] of Object.entries(result.agentOutputs)) {
      const agent = this.registry.get(id);
      lines.push(
        `  ${CYAN}⏺${RESET} ${agent?.name || id}: ${output.slice(0, 80)}${output.length > 80 ? "..." : ""}`
      );
    }

    return lines.join("\n");
  }

  async route(task: string): Promise<string> {
    const scored = this.registry.scoreAgents(task);
    if (scored.length === 0) {
      return "No agents match this task.";
    }

    const lines = scored.slice(0, 5).map(({ agent, score }) => {
      return `  ${score > 50 ? GREEN : score > 20 ? YELLOW : DIM}${score.toFixed(0)}${RESET} ${agent.name} (${agent.id})`;
    });

    return `${BOLD}Routing Analysis for:${RESET} "${task}"\n\n${lines.join("\n")}`;
  }
}

// ---------------------------------------------------------------------------
// Export singleton
// ---------------------------------------------------------------------------

export const swarmCLI = new SwarmCLI();
