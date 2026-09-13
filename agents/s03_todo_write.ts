#!/usr/bin/env node
// Harness: planning -- keeping the model on course without scripting the route.
/**
 * s03_todo_write.ts - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> | Tools   |
 *     |  prompt  |      |       |      | + todo  |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                                 |
 *                     +-----------+-----------+
 *                     | TodoManager state     |
 *                     | [ ] task A            |
 *                     | [>] task B <- doing   |
 *                     | [x] task C            |
 *                     +-----------------------+
 *                                 |
 *                     if rounds_since_todo >= 3:
 *                       inject <reminder>
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

interface TodoItem {
  id: string;
  text: string;
  status: string;
}

// -- TodoManager: structured state the LLM writes to --
class TodoManager {
  items: TodoItem[];

  constructor() {
    this.items = [];
  }

  update(items: any[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }
    const validated: TodoItem[] = [];
    let in_progress_count = 0;
    items.forEach((item, i) => {
      const text = String(item["text"] ?? "").trim();
      const status = String(item["status"] ?? "pending").toLowerCase();
      const item_id = String(item["id"] ?? String(i + 1));
      if (!text) {
        throw new Error(`Item ${item_id}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${item_id}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        in_progress_count += 1;
      }
      validated.push({ id: item_id, text, status });
    });
    if (in_progress_count > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }
    const lines: string[] = [];
    for (const item of this.items) {
      const marker: Record<string, string> = {
        pending: "[ ]",
        in_progress: "[>]",
        completed: "[x]",
      };
      lines.push(`${marker[item.status]} #${item.id}: ${item.text}`);
    }
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

// -- Tool implementations --
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
  todo: (kw) => TODO.update(kw["items"]),
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
  {
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

// -- Agent loop with nag reminder injection --
async function agent_loop(messages: any[]): Promise<void> {
  let rounds_since_todo = 0;
  while (true) {
    // Nag reminder is injected below, alongside tool results
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
    let used_todo = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler
            ? handler(block.input)
            : `Unknown tool: ${block.name}`;
        } catch (e: any) {
          output = `Error: ${e.message ?? e}`;
        }
        console.log(`> ${block.name}:`);
        console.log(String(output).slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
        if (block.name === "todo") {
          used_todo = true;
        }
      }
    }
    rounds_since_todo = used_todo ? 0 : rounds_since_todo + 1;
    if (rounds_since_todo >= 3) {
      results.push({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
      });
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
      query = await ask("\x1b[36ms03 >> \x1b[0m");
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
