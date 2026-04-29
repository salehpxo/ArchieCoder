#!/usr/bin/env -S npx tsx
/**
 * swarm-executor.ts — Real LLM-backed Agent Execution
 *
 * This module provides the actual agent execution logic that integrates
 * with nanocode's existing API calling infrastructure (callApi).
 *
 * Usage:
 *   import { executeAgentTask, executeSwarmWithLLM } from "./swarm-executor";
 *   const results = await executeSwarmWithLLM(task, pattern, agents, { callApi });
 */

import type { AgentDefinition, SwarmPattern, SwarmMessage } from "./swarm.ts";

// Re-use types from main file — in production these would be imported
interface ContentBlockText { type: "text"; text: string; }
interface ContentBlockToolUse { type: "tool_use"; id: string; name: string; input: Record<string, any>; }
type ContentBlock = ContentBlockText | ContentBlockToolUse;
interface ApiResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
}
interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[] | any[];
  rawAssistantMessage?: Record<string, any>;
}
interface CallApiResult {
  response: ApiResponse;
  rawAssistantMessage?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Agent Task & Result Types
// ---------------------------------------------------------------------------

export interface AgentTask {
  agent: AgentDefinition;
  task: string;
  context: string;
  parentTask: string;
}

export interface AgentResult {
  agentId: string;
  output: string;
  toolCalls: Array<{ name: string; args: Record<string, any>; result: string }>;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Execute Single Agent Task with Real LLM
// ---------------------------------------------------------------------------

export async function executeAgentTask(
  task: AgentTask,
  callApi: (messages: Message[], systemPrompt: string) => Promise<CallApiResult>,
  onToolCall?: (name: string, args: any) => Promise<string>
): Promise<AgentResult> {
  const startTime = Date.now();
  const { agent, task: taskDesc, context, parentTask } = task;

  // Build agent-specific system prompt
  const systemPrompt = buildAgentSystemPrompt(agent, taskDesc, parentTask, context);

  // Build conversation messages
  const messages: Message[] = [
    {
      role: "user",
      content: `Please complete this task: ${taskDesc}\n\nAdditional context:\n${context}`,
    },
  ];

  // Temporarily override model if agent specifies one
  const originalModel = process.env.MODEL;
  const originalTemp = process.env.TEMPERATURE;

  if (agent.model) {
    process.env.MODEL = agent.model;
  }
  if (agent.temperature !== undefined) {
    process.env.TEMPERATURE = String(agent.temperature);
  }

  try {
    const { response } = await callApi(messages, systemPrompt);

    // Extract text output and tool calls
    let output = "";
    const toolCalls: AgentResult["toolCalls"] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        output += block.text + "\n";
      } else if (block.type === "tool_use") {
        // Execute the tool call if handler provided
        let toolResult = "[Tool not executed — no handler]";
        if (onToolCall) {
          try {
            toolResult = await onToolCall(block.name, block.input);
          } catch (err: any) {
            toolResult = `error: ${err.message ?? err}`;
          }
        }

        toolCalls.push({
          name: block.name,
          args: block.input,
          result: toolResult,
        });

        // Add tool result to messages for next turn (if needed)
        // This would be handled by the caller in a loop
      }
    }

    return {
      agentId: agent.id,
      output: output.trim(),
      toolCalls,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Restore original env
    if (agent.model) {
      if (originalModel) process.env.MODEL = originalModel;
      else delete process.env.MODEL;
    }
    if (agent.temperature !== undefined) {
      if (originalTemp) process.env.TEMPERATURE = originalTemp;
      else delete process.env.TEMPERATURE;
    }
  }
}

// ---------------------------------------------------------------------------
// Execute Full Swarm with Real LLM Calls
// ---------------------------------------------------------------------------

export interface SwarmExecutionOptions {
  maxConcurrent?: number;
  onProgress?: (agentId: string, status: string) => void;
  onToolCall?: (name: string, args: any) => Promise<string>;
}

export async function executeSwarmWithLLM(
  task: string,
  pattern: SwarmPattern,
  agents: AgentDefinition[],
  callApi: (messages: Message[], systemPrompt: string) => Promise<CallApiResult>,
  options: SwarmExecutionOptions = {}
): Promise<Record<string, AgentResult>> {
  const results: Record<string, AgentResult> = {};
  const maxConcurrent = options.maxConcurrent || 4;

  switch (pattern) {
    case "supervisor": {
      const supervisor = agents.find((a) => a.capabilities.includes("planning")) || agents[0];
      const workers = agents.filter((a) => a.id !== supervisor.id);

      // Supervisor plans
      options.onProgress?.(supervisor.id, "planning");
      const planResult = await executeAgentTask(
        {
          agent: supervisor,
          task: `Create a detailed execution plan for: ${task}`,
          context: "",
          parentTask: task,
        },
        callApi,
        options.onToolCall
      );
      results[supervisor.id] = planResult;

      // Parse plan and execute steps (simplified — in production, parse structured output)
      const steps = workers.map((w, i) => ({
        agent: w,
        description: `Execute step ${i + 1} for: ${task}`,
      }));

      for (const step of steps) {
        options.onProgress?.(step.agent.id, "working");
        const result = await executeAgentTask(
          {
            agent: step.agent,
            task: step.description,
            context: planResult.output,
            parentTask: task,
          },
          callApi,
          options.onToolCall
        );
        results[step.agent.id] = result;
      }

      break;
    }

    case "pipeline": {
      let pipelineContext = "";
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        options.onProgress?.(agent.id, "working");

        const result = await executeAgentTask(
          {
            agent,
            task: `${task}\n\nPrevious output:\n${pipelineContext}`,
            context: pipelineContext,
            parentTask: task,
          },
          callApi,
          options.onToolCall
        );
        results[agent.id] = result;
        pipelineContext = result.output;
      }
      break;
    }

    case "swarm":
    case "map-reduce": {
      // Execute all agents in parallel with concurrency limit
      const executing = new Set<Promise<void>>();

      for (const agent of agents) {
        const promise = (async () => {
          options.onProgress?.(agent.id, "working");

          const subtask =
            pattern === "map-reduce"
              ? `${task} (focus on your specialty: ${agent.capabilities.join(", ")})`
              : task;

          const result = await executeAgentTask(
            {
              agent,
              task: subtask,
              context: "",
              parentTask: task,
            },
            callApi,
            options.onToolCall
          );
          results[agent.id] = result;
        })();

        executing.add(promise);

        if (executing.size >= maxConcurrent) {
          await Promise.race(executing);
          executing.delete(promise);
        }
      }

      await Promise.all(executing);
      break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Synthesize Results from Multiple Agents
// ---------------------------------------------------------------------------

export function synthesizeAgentResults(
  task: string,
  results: Record<string, AgentResult>
): string {
  const parts = Object.entries(results).map(([id, result]) => {
    return `### ${id}\n${result.output}\n\n*(took ${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls.length} tool calls)*`;
  });

  return `# Results for: ${task}\n\n${parts.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Build Agent System Prompt
// ---------------------------------------------------------------------------

function buildAgentSystemPrompt(
  agent: AgentDefinition,
  task: string,
  parentTask: string,
  context: string
): string {
  const parts: string[] = [
    agent.systemPrompt,
    "",
    "## Current Task",
    task,
    "",
    "## Parent Task Context",
    parentTask,
  ];

  if (context) {
    parts.push("", "## Previous Steps / Context", context);
  }

  parts.push(
    "",
    `## Available Tools`,
    `You have access to these tools: ${agent.tools.join(", ")}.`,
    `Use them as needed to complete your task.`,
    "",
    `## Rules`,
    `- Be concise and focused`,
    `- Only use tools relevant to your expertise`,
    `- If you need help from another agent, mention it in your response`,
    `- Report completion status clearly`,
    `- Follow the output format specified in your system prompt`
  );

  if (agent.behavior?.max_iterations) {
    parts.push(
      ``,
      `## Iteration Limit`,
      `You may self-correct up to ${agent.behavior.max_iterations} times.`
    );
  }

  return parts.join("\n");
}
