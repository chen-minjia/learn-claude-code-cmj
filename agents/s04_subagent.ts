#!/usr/bin/env node
// Harness: context isolation -- protecting the model's clarity of thought.
/**
 * s04_subagent.ts - Subagents
 *
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, sharing the filesystem, then returns only a summary to the parent.
 *
 *     Parent agent                     Subagent
 *     +------------------+             +------------------+
 *     | messages=[...]   |             | messages=[]      |  <-- fresh
 *     |                  |  dispatch   |                  |
 *     | tool: task       | ---------->| while tool_use:  |
 *     |   prompt="..."   |            |   call tools     |
 *     |   description="" |            |   append results |
 *     |                  |  summary   |                  |
 *     |   result = "..." | <--------- | return last text |
 *     +------------------+             +------------------+
 *               |
 *     Parent context stays clean.
 *     Subagent context is discarded.
 *
 * Key insight: "Process isolation gives context isolation for free."
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID as string;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

// -- Tool implementations shared by parent and child --
function safe_path(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function run_bash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
    }).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e && e.killed && e.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    if (out) return out.slice(0, 50000);
    return `Error: ${e.message ?? e}`;
  }
}

function run_read(pathArg: string, limit: number | null = null): string {
  try {
    let lines = fs.readFileSync(safe_path(pathArg), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more)`]);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
}

function run_write(pathArg: string, content: string): string {
  try {
    const fp = safe_path(pathArg);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
}

function run_edit(pathArg: string, old_text: string, new_text: string): string {
  try {
    const fp = safe_path(pathArg);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(old_text)) {
      return `Error: Text not found in ${pathArg}`;
    }
    fs.writeFileSync(fp, content.replace(old_text, new_text));
    return `Edited ${pathArg}`;
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
}

const TOOL_HANDLERS: Record<string, (kw: any) => string> = {
  bash: (kw) => run_bash(kw["command"]),
  read_file: (kw) => run_read(kw["path"], kw["limit"]),
  write_file: (kw) => run_write(kw["path"], kw["content"]),
  edit_file: (kw) => run_edit(kw["path"], kw["old_text"], kw["new_text"]),
};

// Child gets all base tools except task (no recursive spawning)
const CHILD_TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

// -- Subagent: fresh context, filtered tools, summary-only return --
async function run_subagent(prompt: string): Promise<string> {
  const sub_messages: any[] = [{ role: "user", content: prompt }]; // fresh context
  let response: any;
  for (let i = 0; i < 30; i++) {
    // safety limit
    response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: sub_messages,
      tools: CHILD_TOOLS as any,
      max_tokens: 8000,
    });
    sub_messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      break;
    }
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler
          ? handler(block.input)
          : `Unknown tool: ${block.name}`;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, 50000),
        });
      }
    }
    sub_messages.push({ role: "user", content: results });
  }
  // Only the final text returns to the parent -- child context is discarded
  return (
    response.content
      .filter((b: any) => "text" in b)
      .map((b: any) => b.text)
      .join("") || "(no summary)"
  );
}

// -- Parent tools: base tools + task dispatcher --
const PARENT_TOOLS = CHILD_TOOLS.concat([
  {
    name: "task",
    description:
      "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: {
          type: "string",
          description: "Short description of the task",
        },
      },
      required: ["prompt"],
    },
  } as any,
]);

async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: PARENT_TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;
        if (block.name === "task") {
          const desc = (block.input as any)["description"] ?? "subtask";
          const prompt = (block.input as any)["prompt"] ?? "";
          console.log(`> task (${desc}): ${prompt.slice(0, 80)}`);
          output = await run_subagent(prompt);
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = handler
            ? handler(block.input)
            : `Unknown tool: ${block.name}`;
        }
        console.log(`  ${String(output).slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  const history: any[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms04 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    history.push({ role: "user", content: query });
    await agent_loop(history);
    const responseContent = history[history.length - 1]["content"];
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if ("text" in block) {
          console.log(block.text);
        }
      }
    }
    console.log();
  }
  rl.close();
}

if (require.main === module) {
  main();
}
