#!/usr/bin/env node
/**
 * s02_tool_use.ts - Tools
 *
 * The agent loop from s01 does not change. This lesson adds four tools
 * and a dispatch map:
 *
 *     +----------+      +-------+      +--------------------------+
 *     |   User   | ---> |  LLM  | ---> | Tool Dispatch            |
 *     |  prompt  |      |       |      | bash       -> run_bash   |
 *     +----------+      +---+---+      | read_file  -> run_read   |
 *                           ^          | write_file -> run_write  |
 *                           |          | edit_file  -> run_edit   |
 *                           +----------+ glob       -> run_glob   |
 *                           tool_result+--------------------------+
 *
 *   + run_read / run_write / run_edit / run_glob
 *   + TOOL_HANDLERS instead of a hard-coded run_bash call
 *   + safe_path to keep file tools inside the workspace
 *
 * Key insight: the loop stays the same; only tool registration and dispatch grow.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";
import { globSync } from "glob";

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

// -- From s01 (unchanged) --

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const out = execSync(command, {
      shell: "/bin/sh",
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e && (e.stdout !== undefined || e.stderr !== undefined)) {
      if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
        return "Error: Timeout (120s)";
      }
      const out = ((e.stdout || "") + (e.stderr || "")).trim();
      return out ? out.slice(0, 50000) : "(no output)";
    }
    return `Error: ${e}`;
  }
}

// -- New in s02: four tools --

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runRead(pathArg: string, limit: number | null = null): string {
  try {
    let lines = fs.readFileSync(safePath(pathArg), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more lines)`]);
    }
    return lines.join("\n");
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

function runWrite(pathArg: string, content: string): string {
  try {
    const filePath = safePath(pathArg);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${content.length} bytes to ${pathArg}`;
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

function runEdit(pathArg: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(pathArg);
    const text = fs.readFileSync(filePath, "utf-8");
    if (!text.includes(oldText)) {
      return `Error: text not found in ${pathArg}`;
    }
    fs.writeFileSync(filePath, text.replace(oldText, newText));
    return `Edited ${pathArg}`;
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const results: string[] = [];
    for (const match of globSync(pattern, { cwd: WORKDIR })) {
      const resolved = path.resolve(WORKDIR, match);
      const rel = path.relative(WORKDIR, resolved);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        results.push(match);
      }
    }
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

// -- New in s02: tool definitions (one tool in s01, five in s02) --

const TOOLS: any[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "glob", description: "Find files matching a glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];

// -- New in s02: dispatch map (replaces s01's hard-coded run_bash call) --

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
};

// -- The agent loop keeps the same shape as s01; only dispatch changes --
// s01: output = run_bash(block.input["command"])
// s02: output = TOOL_HANDLERS[block.name](**block.input)

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: any[] = [];
    for (const block of response.content as any[]) {
      if (block.type === "tool_use") {
        console.log(`\x1b[33m> ${block.name}\x1b[0m`);
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input) : `Unknown: ${block.name}`;
        console.log(String(output).slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }

    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("s02: Tool Use - four tools added to s01");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const history: any[] = [];
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
    await agentLoop(history);
    for (const block of history[history.length - 1]["content"]) {
      if (block?.type === "text") {
        console.log(block.text);
      }
    }
    console.log();
  }
  rl.close();
}

if (require.main === module) {
  main();
}
