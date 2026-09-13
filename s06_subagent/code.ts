#!/usr/bin/env node
/**
 * s06_subagent.ts - Subagents
 *
 * The task tool runs a second agent loop with a fresh message list. Both
 * loops share the working directory, but only the final text returns to
 * the parent conversation.
 *
 *     Parent agent                    Subagent
 *     +------------------+            +------------------+
 *     | messages=[...]   |            | messages=[prompt]|
 *     |                  |   task     |                  |
 *     | tool: task       | ---------> | own agent loop   |
 *     |                  |            | base tools only  |
 *     | tool_result      | <--------- | final text       |
 *     +------------------+            +------------------+
 *
 * The subagent has no task tool, so it cannot delegate again.
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

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task for focused exploration or a self-contained subtask.";
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the given task, then return a concise final answer.";

// A shared readline interface so hook prompts can block for input.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string): Promise<string> =>
  new Promise((resolve) => rl.question(prompt, resolve));

// Helper mirroring Path.is_relative_to(WORKDIR).
function isInsideWorkspace(p: string): boolean {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// -- Base tools --

function runBash(command: string): string {
  try {
    const output = execSync(command, {
      shell: "/bin/sh",
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output ? output.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e && (e.signal === "SIGTERM" || e.code === "ETIMEDOUT")) {
      return "Error: Timeout (120s)";
    }
    const output = ((e.stdout || "") + (e.stderr || "")).trim();
    return output ? output.slice(0, 50000) : "(no output)";
  }
}

function runRead(pathArg: string, limit: number | null = null): string {
  try {
    let lines = fs.readFileSync(path.resolve(WORKDIR, pathArg), "utf-8").split("\n");
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
    const filePath = path.resolve(WORKDIR, pathArg);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${content.length} bytes to ${pathArg}`;
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

function runEdit(pathArg: string, oldText: string, newText: string): string {
  try {
    const filePath = path.resolve(WORKDIR, pathArg);
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
    const matches: string[] = [];
    for (const match of globSync(pattern, { cwd: WORKDIR })) {
      if (isInsideWorkspace(match)) {
        matches.push(match);
      }
    }
    return matches.length ? matches.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

const BASE_TOOLS: any[] = [
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

const BASE_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
};

// -- Hooks --

const HOOKS: Record<string, ((...args: any[]) => any)[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event].push(callback);
}

async function triggerHooks(event: string, ...args: any[]): Promise<any> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

async function permissionHook(block: any): Promise<string | null> {
  /** PreToolUse: block denied operations and ask about risky ones. */
  if (block.name === "bash") {
    const command = block.input.command ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    for (const keyword of DESTRUCTIVE) {
      if (command.includes(keyword)) {
        console.log("\n\x1b[33m[permission] Potentially destructive command\x1b[0m");
        console.log(`   Tool: ${block.name}(${JSON.stringify(block.input)})`);
        const choice = (await ask("   Allow? [y/N] ")).trim().toLowerCase();
        if (!["y", "yes"].includes(choice)) {
          return "Permission denied by user";
        }
      }
    }
  }

  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const p = block.input.path ?? "";
    if (!isInsideWorkspace(p)) {
      console.log("\n\x1b[33m[permission] Access outside workspace\x1b[0m");
      console.log(`   Tool: ${block.name}(${JSON.stringify(block.input)})`);
      const choice = (await ask("   Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

function logHook(block: any): null {
  /** PreToolUse: log every tool call. */
  const argsPreview = String(Object.values(block.input).slice(0, 2)).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${argsPreview})\x1b[0m`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  /** PostToolUse: warn on large output. */
  if (String(output).length > 100000) {
    console.log(`\x1b[33m[HOOK] Large output from ${block.name}: ${String(output).length} chars\x1b[0m`);
  }
  return null;
}

function contextInjectHook(_query: string): null {
  /** UserPromptSubmit: log the working directory. */
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

function summaryHook(messages: any[]): null {
  /** Stop: print the number of tool results in this message list. */
  let toolCount = 0;
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "tool_result") {
        toolCount += 1;
      }
    }
  }
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);

async function executeTool(block: any, handlers: Record<string, (input: any) => string>): Promise<string> {
  const blocked = await triggerHooks("PreToolUse", block);
  if (blocked) {
    return String(blocked);
  }

  const handler = handlers[block.name];
  let output: any;
  try {
    output = handler ? handler(block.input) : `Unknown: ${block.name}`;
  } catch (e: any) {
    output = `Error: ${e}`;
  }

  await triggerHooks("PostToolUse", block, output);
  return String(output);
}

// -- New in s06: a nested agent loop with fresh messages --

const SUB_TOOLS = [...BASE_TOOLS];
const SUB_HANDLERS = { ...BASE_HANDLERS };

function extractText(content: any): string {
  if (!Array.isArray(content)) {
    return String(content);
  }
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

async function runSubagent(prompt: string): Promise<string> {
  console.log("\n\x1b[35m[Subagent started]\x1b[0m");
  const messages: any[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < 30; i++) {
    const response = await client.messages.create({
      model: MODEL,
      system: SUB_SYSTEM,
      messages,
      tools: SUB_TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      console.log("\x1b[35m[Subagent done]\x1b[0m");
      return extractText(response.content) || "(no summary)";
    }

    const results: any[] = [];
    for (const block of response.content as any[]) {
      if (block.type !== "tool_use") {
        continue;
      }
      const output = await executeTool(block, SUB_HANDLERS);
      console.log(`  \x1b[90m[sub] ${block.name}: ${output.slice(0, 100)}\x1b[0m`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }

  console.log("\x1b[35m[Subagent stopped]\x1b[0m");
  return "Subagent stopped after 30 turns without a final answer.";
}

const TASK_TOOL = {
  name: "task",
  description: "Run a subagent with fresh conversation context and return its final text.",
  input_schema: {
    type: "object",
    properties: { prompt: { type: "string", minLength: 1 } },
    required: ["prompt"],
  },
};

const TOOLS = [...BASE_TOOLS, TASK_TOOL];
const TOOL_HANDLERS: Record<string, (input: any) => string | Promise<string>> = {
  ...BASE_HANDLERS,
  task: (input: any) => runSubagent(input.prompt),
};

// -- Parent agent loop --

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
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return;
    }

    const results: any[] = [];
    for (const block of response.content as any[]) {
      if (block.type !== "tool_use") {
        continue;
      }
      // Parent dispatch: the "task" handler runs a full nested loop.
      const blocked = await triggerHooks("PreToolUse", block);
      let output: string;
      if (blocked) {
        output = String(blocked);
      } else {
        const handler = TOOL_HANDLERS[block.name];
        try {
          output = handler ? String(await handler(block.input)) : `Unknown: ${block.name}`;
        } catch (e: any) {
          output = `Error: ${e}`;
        }
        await triggerHooks("PostToolUse", block, output);
      }
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("s06: Subagent - fresh messages, final text returns");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms06 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    await triggerHooks("UserPromptSubmit", query);
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
