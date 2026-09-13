#!/usr/bin/env node
/**
 * s05_todo_write.ts - TodoWrite
 *
 * The model tracks its progress through a TodoManager. After three rounds
 * without an update, the harness adds a reminder alongside the tool results.
 *
 *     +----------+      +-------+      +--------------+
 *     |   User   | ---> |  LLM  | ---> | Tools        |
 *     |  prompt  |      |       |      | + todo_write |
 *     +----------+      +---^---+      +------+-------+
 *                           |                 | update
 *                           |          +------v----------+
 *                           |          | TodoManager     |
 *                           |          | [ ] pending     |
 *                           |          | [>] in progress |
 *                           |          | [x] completed   |
 *                           |          +------+----------+
 *                           | tool_result     |
 *                           +-----------------+
 *
 *               rounds_since_todo >= 3 -> add <reminder>
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

// s05 change: SYSTEM prompt adds planning guidance
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Before starting any multi-step task, use todo_write to plan your steps. " +
  "Update status as you go.";

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

// -- Tool implementations from s02-s04 --

function runBash(command: string): string {
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
    if (e && (e.signal === "SIGTERM" || e.code === "ETIMEDOUT")) {
      return "Error: Timeout (120s)";
    }
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    return out ? out.slice(0, 50000) : "(no output)";
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
    const results: string[] = [];
    for (const match of globSync(pattern, { cwd: WORKDIR })) {
      if (isInsideWorkspace(match)) {
        results.push(match);
      }
    }
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

// -- New in s05: structured state the model updates --

interface TodoItem {
  content: string;
  status: string;
}

class TodoManager {
  items: TodoItem[] = [];

  update(todos: TodoItem[] | string): string {
    if (typeof todos === "string") {
      try {
        todos = JSON.parse(todos);
      } catch {
        // No direct equivalent of ast.literal_eval; JSON parsing is the fallback.
        throw new Error("todos must be a list or JSON array string");
      }
    }

    if (!Array.isArray(todos)) {
      throw new Error("todos must be a list");
    }
    if (todos.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated: TodoItem[] = [];
    let inProgressCount = 0;
    todos.forEach((todo: any, index: number) => {
      if (typeof todo !== "object" || todo === null || Array.isArray(todo)) {
        throw new Error(`todos[${index}] must be an object`);
      }

      const content = String(todo.content ?? "").trim();
      const status = String(todo.status ?? "pending").toLowerCase();
      if (!content) {
        throw new Error(`todos[${index}] requires content`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`todos[${index}] has invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount += 1;
      }
      validated.push({ content, status });
    });

    if (inProgressCount > 1) {
      throw new Error("Only one todo can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) {
      return "No todos.";
    }

    const lines: string[] = [];
    for (const todo of this.items) {
      const marker = ({
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      } as Record<string, string>)[todo.status];
      lines.push(`${marker} ${todo.content}`);
    }

    const done = this.items.filter((todo) => todo.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

function runTodoWrite(todos: TodoItem[] | string): string {
  let output: string;
  try {
    output = TODO.update(todos);
  } catch (e: any) {
    return `Error: ${e.message ?? e}`;
  }
  console.log(`\n\x1b[33m## Current Tasks\x1b[0m\n${output}`);
  return output;
}

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
  // s05: new tool
  { name: "todo_write", description: "Create and manage a task list for your current coding session.",
    input_schema: { type: "object", properties: { todos: { type: "array", maxItems: 20, items: { type: "object", properties: { content: { type: "string", minLength: 1 }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] } },
];

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
  todo_write: (input: any) => runTodoWrite(input.todos),
};

// -- Hook system from s04 --

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
  /** PreToolUse: s03 permission logic, registered as an s04 hook. */
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
        console.log(`\n\x1b[33m[permission] Potentially destructive command\x1b[0m`);
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
      console.log(`\n\x1b[33m[permission] Access outside workspace\x1b[0m`);
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
  /** UserPromptSubmit: log working directory. */
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

function summaryHook(messages: any[]): null {
  /** Stop: print tool call count. */
  let toolCount = 0;
  for (const m of messages) {
    const content = Array.isArray(m.content) ? m.content : [];
    for (const b of content) {
      if (b && typeof b === "object" && b.type === "tool_result") {
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

// -- Agent loop with the reminder counter --

async function agentLoop(messages: any[]): Promise<void> {
  let roundsSinceTodo = 0;
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
    let usedTodo = false;
    for (const block of response.content as any[]) {
      if (block.type !== "tool_use") {
        continue;
      }

      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(blocked) });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      let output: any;
      try {
        output = handler ? handler(block.input) : `Unknown: ${block.name}`;
      } catch (e: any) {
        output = `Error: ${e}`;
      }

      await triggerHooks("PostToolUse", block, output);

      if (block.name === "todo_write") {
        usedTodo = true;
      }

      results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.push({ type: "text", text: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("s05: TodoWrite - plan before execution");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms05 >> \x1b[0m");
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
