#!/usr/bin/env node
/**
 * s10_task_system.ts - Task System
 *
 *     .tasks/
 *       task_a1b2c3d4.json  {status: completed, blockedBy: []}
 *       task_e5f6a7b8.json  {status: pending, blockedBy: [task_a1b2c3d4]}
 *       task_11223344.json  {status: pending, blockedBy: [task_e5f6a7b8]}
 *
 *     Dependency graph:
 *
 *     +-----------+      +-----------+      +-----------+
 *     | schema    | ---> | API       | ---> | tests     |
 *     | completed |      | pending   |      | pending   |
 *     +-----------+      +-----------+      +-----------+
 *
 *     can_start(API) is true because schema is completed.
 *
 *     Task lifecycle:
 *
 *     pending --claim_task--> in_progress --complete_task--> completed
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as crypto from "crypto";
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
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task tools to track dependencies and progress.";

// 判断 child 是否在 parent 之下（等价于 Python 的 Path.is_relative_to）
function isRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function promptInput(prompt: string): string {
  return readlineSync.question(prompt);
}

// -- New in s10: persistent task records --

const TASKS_DIR: string = path.join(WORKDIR, ".tasks");
const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;

// @dataclass Task
interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  blockedBy: string[];
}

class TaskStore {
  directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private _root(create = false): string {
    if (create) {
      fs.mkdirSync(this.directory, { recursive: true });
    }
    const root = path.resolve(this.directory);
    if (!isRelativeTo(root, path.resolve(WORKDIR))) {
      throw new Error("Task store escapes the workspace");
    }
    return root;
  }

  private _path(taskId: string, createRoot = false): string {
    if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`Invalid task ID: ${JSON.stringify(taskId)}`);
    }
    const root = this._root(createRoot);
    const p = path.resolve(path.join(root, `${taskId}.json`));
    if (!isRelativeTo(p, root)) {
      throw new Error(`Invalid task ID: ${JSON.stringify(taskId)}`);
    }
    return p;
  }

  exists(taskId: string): boolean {
    try {
      return fs.statSync(this._path(taskId)).isFile();
    } catch (e) {
      return false;
    }
  }

  create(subject: string, description = "", blockedBy: string[] | null = null): Task {
    subject = subject.trim();
    if (!subject) {
      throw new Error("Task subject cannot be empty");
    }

    // dict.fromkeys 去重并保序
    const dependencies = Array.from(new Set(blockedBy || []));
    for (const dependency of dependencies) {
      if (!this.exists(dependency)) {
        throw new Error(`Dependency not found: ${dependency}`);
      }
    }

    this._root(true);
    for (let i = 0; i < 100; i++) {
      const task: Task = {
        id: `task_${crypto.randomBytes(4).toString("hex")}`,
        subject,
        description,
        status: "pending",
        owner: null,
        blockedBy: dependencies,
      };
      const filePath = this._path(task.id, true);
      try {
        // "x" 模式：文件已存在时抛错
        const fd = fs.openSync(filePath, "wx");
        fs.writeFileSync(fd, JSON.stringify(task, null, 2));
        fs.closeSync(fd);
        return task;
      } catch (error: any) {
        if (error.code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Could not allocate a unique task ID");
  }

  save(task: Task): void {
    fs.writeFileSync(this._path(task.id, true), JSON.stringify(task, null, 2), "utf-8");
  }

  load(taskId: string): Task {
    const data = JSON.parse(fs.readFileSync(this._path(taskId), "utf-8"));
    const task: Task = data;
    if (task.id !== taskId) {
      throw new Error(`Task file ID does not match ${taskId}`);
    }
    if (!["pending", "in_progress", "completed"].includes(task.status)) {
      throw new Error(`Invalid task status: ${task.status}`);
    }
    return task;
  }

  list(): Task[] {
    if (!fs.existsSync(this.directory)) {
      return [];
    }
    const root = this._root();
    const files = glob.sync(path.join(root, "task_*.json")).sort();
    return files.map((filePath) =>
      this.load(path.basename(filePath, path.extname(filePath)))
    );
  }
}

const TASKS = new TaskStore(TASKS_DIR);

function createTask(subject: string, description = "", blockedBy: string[] | null = null): Task {
  return TASKS.create(subject, description, blockedBy);
}

function loadTask(taskId: string): Task {
  return TASKS.load(taskId);
}

function listTasks(): Task[] {
  return TASKS.list();
}

function getTask(taskId: string): string {
  return JSON.stringify(loadTask(taskId), null, 2);
}

function incompleteDependencies(task: Task): string[] {
  const incomplete: string[] = [];
  for (const dependency of task.blockedBy) {
    try {
      if (loadTask(dependency).status !== "completed") {
        incomplete.push(dependency);
      }
    } catch (e) {
      // FileNotFoundError 或 ValueError
      incomplete.push(dependency);
    }
  }
  return incomplete;
}

function canStart(taskId: string): boolean {
  return incompleteDependencies(loadTask(taskId)).length === 0;
}

function claimTask(taskId: string, owner = "agent"): string {
  const task = loadTask(taskId);
  if (task.status !== "pending") {
    return `Task ${taskId} is ${task.status}, cannot claim`;
  }
  const dependencies = incompleteDependencies(task);
  if (dependencies.length) {
    return `Blocked by: ${JSON.stringify(dependencies)}`;
  }
  task.owner = owner;
  task.status = "in_progress";
  TASKS.save(task);
  console.log(`  [claim] ${task.subject} -> in_progress (owner: ${owner})`);
  return `Claimed ${task.id} (${task.subject})`;
}

function completeTask(taskId: string, owner = "agent"): string {
  const task = loadTask(taskId);
  if (task.status !== "in_progress") {
    return `Task ${taskId} is ${task.status}, cannot complete`;
  }
  if (task.owner !== owner) {
    return `Task ${taskId} is owned by ${task.owner}, not ${owner}`;
  }
  const readyBefore = new Set(
    listTasks()
      .filter(
        (candidate) =>
          candidate.status === "pending" &&
          candidate.blockedBy.length &&
          canStart(candidate.id)
      )
      .map((candidate) => candidate.id)
  );
  task.status = "completed";
  TASKS.save(task);
  const unblocked = listTasks()
    .filter(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.blockedBy.length &&
        !readyBefore.has(candidate.id) &&
        canStart(candidate.id)
    )
    .map((candidate) => candidate.subject);
  console.log(`  [complete] ${task.subject}`);
  let message = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    message += `\nUnblocked: ${unblocked.join(", ")}`;
    console.log(`  [unblocked] ${unblocked.join(", ")}`);
  }
  return message;
}

// -- From s04: tool implementations --

function runBash(command: string): string {
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return output ? output.slice(0, 50000) : "(no output)";
  } catch (error: any) {
    if (error.killed || error.signal === "SIGTERM") {
      return "Error: Timeout (120s)";
    }
    const output = ((error.stdout || "") + (error.stderr || "")).toString().trim();
    return output ? output.slice(0, 50000) : "(no output)";
  }
}

function runRead(pathArg: string, limit: number | null = null): string {
  try {
    let lines = fs
      .readFileSync(path.resolve(path.join(WORKDIR, pathArg)), "utf-8")
      .split("\n");
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

function runCreateTask(subject: string, description = "", blockedBy: string[] | null = null): string {
  const task = createTask(subject, description, blockedBy);
  const dependencies = task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(", ")})` : "";
  console.log(`  [create] ${task.subject}${dependencies}`);
  return `Created ${task.id}: ${task.subject}${dependencies}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (!tasks.length) {
    return "No tasks. Use create_task to add some.";
  }
  const lines: string[] = [];
  for (const task of tasks) {
    const marker =
      ({ pending: "[ ]", in_progress: "[>]", completed: "[x]" } as Record<string, string>)[
        task.status
      ] || "[?]";
    const dependencies = task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(", ")})` : "";
    const owner = task.owner ? ` [${task.owner}]` : "";
    lines.push(`${marker} ${task.id}: ${task.subject} [${task.status}]${owner}${dependencies}`);
  }
  return lines.join("\n");
}

function runGetTask(taskId: string): string {
  return getTask(taskId);
}

function runClaimTask(taskId: string): string {
  return claimTask(taskId, "agent");
}

function runCompleteTask(taskId: string): string {
  return completeTask(taskId, "agent");
}

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
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
  {
    name: "create_task",
    description: "Create a task with optional dependencies.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
        blockedBy: { type: "array", items: { type: "string" } },
      },
      required: ["subject"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks with status, owner, and dependencies.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_task",
    description: "Get a task by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  },
  {
    name: "claim_task",
    description: "Claim a pending task whose dependencies are complete.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  },
  {
    name: "complete_task",
    description: "Complete the task claimed by this agent.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  },
];

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
  create_task: (input: any) => runCreateTask(input.subject, input.description ?? "", input.blockedBy ?? null),
  list_tasks: () => runListTasks(),
  get_task: (input: any) => runGetTask(input.task_id),
  claim_task: (input: any) => runClaimTask(input.task_id),
  complete_task: (input: any) => runCompleteTask(input.task_id),
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

function contextHook(query: string): null {
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

registerHook("UserPromptSubmit", contextHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);

function executeTool(block: any): string {
  const blocked = triggerHooks("PreToolUse", block);
  if (blocked) {
    return String(blocked);
  }

  const handler = TOOL_HANDLERS[block.name];
  let output: string;
  try {
    output = handler ? handler(block.input) : `Unknown: ${block.name}`;
  } catch (error) {
    output = `Error: ${error}`;
  }

  triggerHooks("PostToolUse", block, output);
  return String(output);
}

// -- Agent loop --

async function agentLoop(messages: any[]): Promise<void> {
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
  console.log("s10: Task System - dependencies and task state");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = promptInput("\x1b[36ms10 >> \x1b[0m");
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
