#!/usr/bin/env node
// Harness: persistent tasks -- goals that outlive any single conversation.
/**
 * s07_task_system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR: string = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL: string = process.env.MODEL_ID as string;
const TASKS_DIR: string = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// -- TaskManager: CRUD with dependency graph, persisted as JSON files --
class TaskManager {
  dir: string;
  private _next_id: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this._next_id = this._maxId() + 1;
  }

  private _maxId(): number {
    const ids = fs
      .readdirSync(this.dir)
      .filter((f) => /^task_.*\.json$/.test(f))
      .map((f) => parseInt(f.replace(/\.json$/, "").split("_")[1], 10));
    return ids.length ? Math.max(...ids) : 0;
  }

  private _load(taskId: number): Record<string, any> {
    const p = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(p)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  private _save(task: Record<string, any>): void {
    const p = path.join(this.dir, `task_${task["id"]}.json`);
    fs.writeFileSync(p, JSON.stringify(task, null, 2));
  }

  create(subject: string, description = ""): string {
    const task: Record<string, any> = {
      id: this._next_id,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      owner: "",
    };
    this._save(task);
    this._next_id += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  update(
    taskId: number,
    status: string | null = null,
    addBlockedBy: number[] | null = null,
    removeBlockedBy: number[] | null = null,
  ): string {
    const task = this._load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task["status"] = status;
      if (status === "completed") {
        this._clearDependency(taskId);
      }
    }
    if (addBlockedBy) {
      task["blockedBy"] = Array.from(
        new Set([...task["blockedBy"], ...addBlockedBy]),
      );
    }
    if (removeBlockedBy) {
      task["blockedBy"] = task["blockedBy"].filter(
        (x: number) => !removeBlockedBy.includes(x),
      );
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  private _clearDependency(completedId: number): void {
    // Remove completed_id from all other tasks' blockedBy lists.
    for (const f of fs
      .readdirSync(this.dir)
      .filter((f) => /^task_.*\.json$/.test(f))) {
      const task = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8"));
      if ((task["blockedBy"] || []).includes(completedId)) {
        task["blockedBy"] = task["blockedBy"].filter(
          (x: number) => x !== completedId,
        );
        this._save(task);
      }
    }
  }

  listAll(): string {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => /^task_.*\.json$/.test(f))
      .sort((a, b) => {
        const ai = parseInt(a.replace(/\.json$/, "").split("_")[1], 10);
        const bi = parseInt(b.replace(/\.json$/, "").split("_")[1], 10);
        return ai - bi;
      });
    const tasks: Record<string, any>[] = [];
    for (const f of files) {
      tasks.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")));
    }
    if (!tasks.length) {
      return "No tasks.";
    }
    const lines: string[] = [];
    for (const t of tasks) {
      const marker =
        (
          { pending: "[ ]", in_progress: "[>]", completed: "[x]" } as Record<
            string,
            string
          >
        )[t["status"]] || "[?]";
      const blocked =
        t["blockedBy"] && t["blockedBy"].length
          ? ` (blocked by: [${t["blockedBy"].join(", ")}])`
          : "";
      lines.push(`${marker} #${t["id"]}: ${t["subject"]}${blocked}`);
    }
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

// -- Base tool implementations --
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!(resolved === WORKDIR || resolved.startsWith(WORKDIR + path.sep))) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

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
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = out.trim();
    return trimmed ? trimmed.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed) {
      return "Error: Timeout (120s)";
    }
    const out = ((e.stdout || "") + (e.stderr || "")).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  }
}

function runRead(p: string, limit: number | null = null): string {
  try {
    let lines = fs.readFileSync(safePath(p), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(p);
    const c = fs.readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) {
      return `Error: Text not found in ${p}`;
    }
    fs.writeFileSync(fp, c.replace(oldText, newText));
    return `Edited ${p}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

const TOOL_HANDLERS: Record<string, (kw: any) => string> = {
  bash: (kw) => runBash(kw.command),
  read_file: (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  task_create: (kw) => TASKS.create(kw.subject, kw.description || ""),
  task_update: (kw) =>
    TASKS.update(kw.task_id, kw.status, kw.addBlockedBy, kw.removeBlockedBy),
  task_list: () => TASKS.listAll(),
  task_get: (kw) => TASKS.get(kw.task_id),
};

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
  {
    name: "task_create",
    description: "Create a new task.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_update",
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
        },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        removeBlockedBy: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status summary.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];

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
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler
            ? handler(block.input)
            : `Unknown tool: ${block.name}`;
        } catch (e: any) {
          output = `Error: ${e.message}`;
        }
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
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
  const readline = await import("readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms07 >> \x1b[0m");
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    const responseContent = history[history.length - 1]["content"];
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (block.text !== undefined) {
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
