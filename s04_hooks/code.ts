#!/usr/bin/env node
/**
 * s04_hooks.ts - Hooks
 *
 * Hooks run callbacks at fixed points in the agent loop:
 *
 *     User prompt
 *          |
 *          v
 *     UserPromptSubmit
 *          |
 *          v
 *     +----------+      +-------+      +------------+      +-------+
 *     | messages | ---> |  LLM  | ---> | PreToolUse | ---> | Tool  |
 *     +----------+      +---+---+      | permission |      +---+---+
 *          ^                | stop     | log        |          |
 *          |                v          +------------+          v
 *          |            Stop hook                         PostToolUse
 *          |                                               |
 *          +---------------- tool_result ------------------+
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

// A shared readline interface so hook prompts can block for input.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const ask = (prompt: string): Promise<string> =>
  new Promise((resolve) => rl.question(prompt, resolve));

// Helper mirroring Path.is_relative_to(WORKDIR).
function isInsideWorkspace(p: string): boolean {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// -- From s02-s03: tool implementations --

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
    const filePath = path.resolve(WORKDIR, pathArg);
    let lines = fs.readFileSync(filePath, "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = lines
        .slice(0, limit)
        .concat([`... (${lines.length - limit} more lines)`]);
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

const TOOLS: any[] = [
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
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in a file once.",
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
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
];

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) =>
    runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
};

// -- New in s04: hook system (s03 permission logic now uses hooks) --

const HOOKS: Record<string, ((...args: any[]) => any)[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event].push(callback);
}

async function triggerHooks(event: string, ß: any[]): Promise<any> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result !== null && result !== undefined) {
      // A hook result blocks this tool call.
      return result;
    }
  }
  return null;
}

// s03 permission check logic, now wrapped as a hook
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

async function permissionHook(block: any): Promise<string | null> {
  /** PreToolUse: s03 check_permission() logic moved here. */
  if (block.name === "bash") {
    for (const pattern of DENY_LIST) {
      if ((block.input.command ?? "").includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    for (const kw of DESTRUCTIVE) {
      if ((block.input.command ?? "").includes(kw)) {
        console.log(
          `\n\x1b[33m[permission] Potentially destructive command\x1b[0m`,
        );
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
  const argsPreview = String(Object.values(block.input).slice(0, 2)).slice(
    0,
    60,
  );
  console.log(`\x1b[90m[HOOK] ${block.name}(${argsPreview})\x1b[0m`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  /** PostToolUse: warn on large output. */
  if (String(output).length > 100000) {
    console.log(
      `\x1b[33m[HOOK] Large output from ${block.name}: ${String(output).length} chars\x1b[0m`,
    );
  }
  return null;
}

// UserPromptSubmit hook: log user input before it reaches the LLM
function contextInjectHook(_query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

// Stop hook: print summary when loop is about to exit
function summaryHook(messages: any[]): null {
  let toolCount = 0;
  for (const m of messages) {
    const contentList = Array.isArray(m.content) ? m.content : [];
    for (const content of contentList) {
      if (
        content &&
        typeof content === "object" &&
        content.type === "tool_result"
      ) {
        toolCount += 1;
      }
    }
  }
  console.log(
    `\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`,
  );
  return null;
}

registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);

// -- Agent loop: same structure as s03, but no hard-coded check --
// s03: if (!checkPermission(block)) ...
// s04: if (await triggerHooks("PreToolUse", block)) ...

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
      // Stop：循环结束前，执行一系列注册的函数
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

      // s04 change: hook replaces hard-coded check_permission()
      // PreToolUse：工具调用前，执行一系列注册的函数
      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(blocked),
        });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(block.input) : `Unknown: ${block.name}`;
      // PostToolUse：工具调用后，执行一系列注册的函数
      await triggerHooks("PostToolUse", block, output); // s04: post hook

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
  console.log("s04: Hooks - extension logic on hooks, loop stays clean");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
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
    // UserPromptSubmit：用户输入前，执行一系列注册的函数
    await triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    // agentLoop：执行主循环，调用LLM，处理工具调用，执行工具，处理工具输出，更新历史记录
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
