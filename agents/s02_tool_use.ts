#!/usr/bin/env node
// Harness: tool dispatch -- expanding what the model can reach.
/**
 * s02_tool_use.ts - Tools
 *
 * The agent loop from s01 didn't change. We just added tools to the array
 * and a dispatch map to route calls.
 *
 *     +----------+      +-------+      +------------------+
 *     |   User   | ---> |  LLM  | ---> | Tool Dispatch    |
 *     |  prompt  |      |       |      | {                |
 *     +----------+      +---+---+      |   bash: run_bash |
 *                           ^          |   read: run_read |
 *                           |          |   write: run_wr  |
 *                           +----------+   edit: run_edit |
 *                           tool_result| }                |
 *                                      +------------------+
 *
 * Key insight: "The loop didn't change at all. I just added tools."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

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
    return out ? out.slice(0, 50000) : "(no output)";
  }
}

function run_read(pathArg: string, limit: number | null = null): string {
  try {
    const text = fs.readFileSync(safe_path(pathArg), "utf-8");
    let lines = text.split("\n");
    if (limit && limit < lines.length) {
      lines = lines
        .slice(0, limit)
        .concat([`... (${lines.length - limit} more lines)`]);
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
    return `Wrote ${content.length} bytes to ${pathArg}`;
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

// -- The dispatch map: {tool_name: handler} --
const TOOL_HANDLERS: Record<string, (kw: any) => string> = {
  bash: (kw) => run_bash(kw["command"]),
  read_file: (kw) => run_read(kw["path"], kw["limit"]),
  write_file: (kw) => run_write(kw["path"], kw["content"]),
  edit_file: (kw) => run_edit(kw["path"], kw["old_text"], kw["new_text"]),
};

const TOOLS = [
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

async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler
          ? handler(block.input)
          : `Unknown tool: ${block.name}`;
        console.log(`> ${block.name}:`);
        console.log(output.slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
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
      query = await ask("\x1b[36ms02 >> \x1b[0m");
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
