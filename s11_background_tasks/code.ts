#!/usr/bin/env node
/**
 * s11_background_tasks.ts - Background Tasks
 *
 *     Main thread                              Background thread
 *     +------------------------------+         +----------------------+
 *     | bash(run_in_background=True) | ------> | run command          |
 *     | return bg_id                 |         | queue result         |
 *     | continue agent loop          | <------ +----------------------+
 *     | next turn: collect           |
 *     +------------------------------+
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync, spawn, ChildProcess } from "child_process";
import * as glob from "glob";
import * as readlineSync from "readline-sync";
import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
// Node 无 Python readline.parse_and_bind 等价物，这里省略 TTY 绑定逻辑。

dotenv.config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR: string = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL: string = process.env.MODEL_ID as string;

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. ` +
  "Set run_in_background to true only for independent Bash commands.";

// 判断 child 是否在 parent 之下（等价于 Python 的 Path.is_relative_to）
function isRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function promptInput(prompt: string): string {
  return readlineSync.question(prompt);
}

// -- From s04: tool implementations --

// 追踪仍存活的子进程集合（对应 Python 的 _shell_processes）
const _shellProcesses: Set<ChildProcess> = new Set();
// Node 是单线程事件循环，无需真实锁；此处仅为对照保留概念。

/** Stop processes that remain in the command's original process group. */
function _stopProcessGroup(proc: ChildProcess): void {
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      if (proc.pid !== undefined) {
        // 负 pid 表示向进程组发送信号（对应 os.killpg）
        process.kill(-proc.pid, sig);
      }
    } catch (e) {
      return;
    }
    // Python 用 time.sleep(0.05)；Node 同步等待较难，这里忽略短暂间隔。
  }
}

function _stopAllShellProcesses(): void {
  const processes = Array.from(_shellProcesses);
  for (const proc of processes) {
    _stopProcessGroup(proc);
  }
}

// 进程退出与信号处理（对应 atexit.register / signal.signal(SIGTERM)）
process.on("exit", _stopAllShellProcesses);
process.on("SIGTERM", () => {
  _stopAllShellProcesses();
  process.exit(128 + 15);
});

// 同步运行 shell 命令，返回 [输出, 退出码]
function _runBashProcess(command: string): [string, number | null] {
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
      // start_new_session=True 的等价：detached 让子进程成为新进程组组长
      detached: true,
    });
    if (result.error && (result.error as any).code === "ETIMEDOUT") {
      return ["Error: Timeout (120s)", null];
    }
    if (result.error) {
      const err = result.error as any;
      return [`Error: ${err.name || "OSError"}: ${err.message}`, null];
    }
    const output = ((result.stdout || "") + (result.stderr || "")).trim();
    return [output ? output.slice(0, 50000) : "(no output)", result.status];
  } catch (error: any) {
    return [`Error: ${error?.constructor?.name || "OSError"}: ${error}`, null];
  }
}

function _formatBashResult(output: string, exitCode: number | null): string {
  if (exitCode === 0 || exitCode === null) {
    return output;
  }
  return `Error: command exited with status ${exitCode}\n${output}`;
}

function runBash(command: string, runInBackground = false): string {
  const [output, exitCode] = _runBashProcess(command);
  return _formatBashResult(output, exitCode);
}

function runRead(pathArg: string, limit: number | null = null): string {
  try {
    const filePath = path.resolve(path.join(WORKDIR, pathArg));
    let lines = fs.readFileSync(filePath, "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more lines)`]);
    }
    return lines.join("\n");
  } catch (error) {
    return `Error: ${error}`;
  }
}

function runWrite(pathArg: string, content: string): string {
  try {
    const filePath = path.resolve(path.join(WORKDIR, pathArg));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${content.length} bytes to ${pathArg}`;
  } catch (error) {
    return `Error: ${error}`;
  }
}

function runEdit(pathArg: string, oldText: string, newText: string): string {
  try {
    const filePath = path.resolve(path.join(WORKDIR, pathArg));
    const text = fs.readFileSync(filePath, "utf-8");
    if (!text.includes(oldText)) {
      return `Error: text not found in ${pathArg}`;
    }
    fs.writeFileSync(filePath, text.replace(oldText, newText)); // 只替换第一处
    return `Edited ${pathArg}`;
  } catch (error) {
    return `Error: ${error}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const matches = glob
      .sync(pattern, { cwd: WORKDIR })
      .filter((match) => isRelativeTo(path.resolve(path.join(WORKDIR, match)), WORKDIR));
    return matches.length ? matches.join("\n") : "(no matches)";
  } catch (error) {
    return `Error: ${error}`;
  }
}

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, run_in_background: { type: "boolean" } },
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
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
];

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: (input: any) => runBash(input.command, input.run_in_background ?? false),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
};

// -- From s04: hooks and permission checks --

const HOOKS: Record<string, ((...args: any[]) => any)[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event].push(callback);
}

function triggerHooks(event: string, ...args: any[]): any {
  for (const callback of HOOKS[event]) {
    const result = callback(...args);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

function permissionHook(block: any): string | null {
  if (block.name === "bash") {
    const command = block.input.command ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    if (DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      console.log("\n\x1b[33m[permission] Potentially destructive command\x1b[0m");
      console.log(`   Tool: ${block.name}(${JSON.stringify(block.input)})`);
      const choice = promptInput("   Allow? [y/N] ").trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }

  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const p = block.input.path ?? "";
    if (!isRelativeTo(path.resolve(path.join(WORKDIR, p)), WORKDIR)) {
      console.log("\n\x1b[33m[permission] Access outside workspace\x1b[0m");
      console.log(`   Tool: ${block.name}(${JSON.stringify(block.input)})`);
      const choice = promptInput("   Allow? [y/N] ").trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

function logHook(block: any): null {
  const preview = String(JSON.stringify(Object.values(block.input).slice(0, 2))).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${preview})\x1b[0m`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  if (String(output).length > 100000) {
    console.log(
      `\x1b[33m[HOOK] Large output from ${block.name}: ${String(output).length} chars\x1b[0m`
    );
  }
  return null;
}

function contextInjectHook(query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

function summaryHook(messages: any[]): null {
  let toolCount = 0;
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "tool_result") {
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

function callTool(block: any): string {
  const handler = TOOL_HANDLERS[block.name];
  let output: string;
  try {
    output = handler ? handler(block.input) : `Unknown: ${block.name}`;
  } catch (error) {
    output = `Error: ${error}`;
  }
  return String(output);
}

// -- New in s11: background execution --

interface BackgroundTaskInfo {
  tool_use_id: string;
  command: string;
  status: string;
}

class BackgroundManager {
  tasks: Record<string, BackgroundTaskInfo> = {};
  results: Record<string, string> = {};
  private _ready: string[] = [];
  private _counter = 0;
  // Node 单线程无需真实锁，_lock 仅为对照保留概念。

  start(block: any): string {
    if (block.name !== "bash") {
      throw new Error("Only Bash commands can run in the background");
    }
    const command = block.input.command;
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("Bash command cannot be empty");
    }

    this._counter += 1;
    const taskId = `bg_${String(this._counter).padStart(4, "0")}`;
    this.tasks[taskId] = {
      tool_use_id: block.id,
      command,
      status: "running",
    };

    // 用后台异步执行模拟 Python 的守护线程
    setImmediate(() => this._run(taskId, command));
    console.log(`  [background] started ${taskId}: ${command.slice(0, 60)}`);
    return taskId;
  }

  private _run(taskId: string, command: string): void {
    let result: string;
    let status: string;
    try {
      const [output, exitCode] = _runBashProcess(command);
      result = _formatBashResult(output, exitCode);
      status = exitCode === 0 ? "completed" : "failed";
    } catch (error: any) {
      result = `Error: ${error?.constructor?.name || "Error"}: ${error}`;
      status = "failed";
    }

    const task = this.tasks[taskId];
    if (task === undefined) {
      return;
    }
    task.status = status;
    this.results[taskId] = result;
    this._ready.push(taskId);
  }

  collect(): string[] {
    const ready: [string, BackgroundTaskInfo, string][] = [];
    for (const taskId of this._ready) {
      const task = this.tasks[taskId];
      const result = this.results[taskId] ?? "";
      delete this.tasks[taskId];
      delete this.results[taskId];
      if (task !== undefined) {
        ready.push([taskId, task, result]);
      }
    }
    this._ready = [];

    const notifications: string[] = [];
    for (const [taskId, task, result] of ready) {
      notifications.push(
        `<task_notification>\n` +
          `  <task_id>${taskId}</task_id>\n` +
          `  <status>${task.status}</status>\n` +
          `  <command>${task.command}</command>\n` +
          `  <summary>${result.slice(0, 500)}</summary>\n` +
          `</task_notification>`
      );
      console.log(`  [background] collected ${taskId}: ${task.status}`);
    }
    return notifications;
  }
}

const BACKGROUND = new BackgroundManager();
const background_tasks = BACKGROUND.tasks;
const background_results = BACKGROUND.results;

function shouldRunBackground(toolName: string, toolInput: Record<string, any>): boolean {
  return toolName === "bash" && toolInput.run_in_background === true;
}

function startBackgroundTask(block: any): string {
  return BACKGROUND.start(block);
}

function collectBackgroundResults(): string[] {
  return BACKGROUND.collect();
}

function injectBackgroundResults(messages: any[]): number {
  const notifications = collectBackgroundResults();
  if (!notifications.length) {
    return 0;
  }

  const blocks = notifications.map((item) => ({ type: "text", text: item }));
  if (messages.length && messages[messages.length - 1].role === "user") {
    const content = messages[messages.length - 1].content ?? "";
    if (Array.isArray(content)) {
      content.push(...blocks);
    } else {
      messages[messages.length - 1].content = [
        { type: "text", text: String(content) },
        ...blocks,
      ];
    }
  } else {
    messages.push({ role: "user", content: blocks });
  }
  return notifications.length;
}

function executeTool(block: any): string {
  const blocked = triggerHooks("PreToolUse", block);
  if (blocked !== null && blocked !== undefined) {
    return String(blocked);
  }

  let output: string;
  if (shouldRunBackground(block.name, block.input)) {
    try {
      const taskId = startBackgroundTask(block);
      output =
        `[Background task ${taskId} started] ` +
        "The result will be collected on a later turn.";
    } catch (error) {
      output = `Error: ${error}`;
    }
  } else {
    output = callTool(block);
  }

  triggerHooks("PostToolUse", block, output);
  return output;
}

// -- Agent loop --

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    injectBackgroundResults(messages);
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return;
    }

    const results: any[] = [];
    for (const block of response.content) {
      if ((block as any).type !== "tool_use") {
        continue;
      }
      const output = executeTool(block);
      results.push({
        type: "tool_result",
        tool_use_id: (block as any).id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("s11: Background Tasks - explicit background Bash execution");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = promptInput("\x1b[36ms11 >> \x1b[0m");
    } catch (e) {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    await agentLoop(history);
    for (const block of history[history.length - 1].content) {
      if ((block as any)?.type === "text") {
        console.log((block as any).text);
      }
    }
    console.log();
  }
}

if (require.main === module) {
  main();
}
