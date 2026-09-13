#!/usr/bin/env node
/**
 * s03_permission.ts - Permission System
 *
 * Three gates inserted before tool execution:
 *
 *     Gate 1: Hard deny list (rm -rf /, sudo, ...)
 *     Gate 2: Rule matching (write outside workspace? destructive cmd?)
 *     Gate 3: User approval (pause and wait for confirmation)
 *
 *     +----------+      +-------+      +--------------+      +---------------+
 *     |   User   | ---> |  LLM  | ---> | Permission   | ---> | Tool Dispatch |
 *     |  prompt  |      |       |      | 1. deny list |      | execute       |
 *     +----------+      +---+---+      | 2. rules     |      +-------+-------+
 *                           ^          | 3. approval  |              |
 *                           |          +------+-------+              |
 *                           |                 | deny                 |
 *                           |                 v                      v
 *                           |          +-------------------------------+
 *                           +----------+ tool_result: denied or output |
 *                                      +-------------------------------+
 *
 * Only one line added to the agent loop:
 *
 *     if (!checkPermission(block)) continue;
 *
 * Builds on s02 (multi-tool). Usage:
 *
 *     node s03_permission/code.js
 *     Needs: npm install @anthropic-ai/sdk dotenv + ANTHROPIC_API_KEY in .env
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. All destructive operations require user approval.`;

// A shared readline interface so the permission prompts can block for input.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string): Promise<string> =>
  new Promise((resolve) => rl.question(prompt, resolve));

// Helper mirroring Path.is_relative_to(WORKDIR).
function isInsideWorkspace(p: string): boolean {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// -- From s02: tool implementations --

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

// -- From s02 (unchanged): tool definitions and dispatch --

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

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
};

// -- New in s03: three-gate permission pipeline --

// Gate 1: Hard deny list - always forbidden
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}

// Gate 2: Rule matching - context-dependent checks
const PERMISSION_RULES: {
  tools: string[];
  check: (args: any) => boolean;
  message: string;
}[] = [
  {
    tools: ["read_file", "write_file", "edit_file"],
    check: (args: any) => !isInsideWorkspace(args.path ?? ""),
    message: "Writing outside workspace",
  },
  {
    tools: ["bash"],
    check: (args: any) => ["rm ", "> /etc/", "chmod 777"].some((kw) => (args.command ?? "").includes(kw)),
    message: "Potentially destructive command",
  },
];

function checkRules(toolName: string, args: any): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(toolName) && rule.check(args)) {
      return rule.message;
    }
  }
  return null;
}

// Gate 3: User approval - wait for confirmation after rule match
async function askUser(toolName: string, args: any, reason: string): Promise<string> {
  console.log(`\n\x1b[33m[permission] ${reason}\x1b[0m`);
  console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
  const choice = (await ask("   Allow? [y/N] ")).trim().toLowerCase();
  return ["y", "yes"].includes(choice) ? "allow" : "deny";
}

// Pipeline: all three gates chained
async function checkPermission(block: any): Promise<boolean> {
  if (block.name === "bash") {
    const reason = checkDenyList(block.input.command ?? "");
    if (reason) {
      console.log(`\n\x1b[31m[blocked] ${reason}\x1b[0m`);
      return false;
    }
  }
  const reason = checkRules(block.name, block.input);
  if (reason) {
    const decision = await askUser(block.name, block.input, reason);
    if (decision === "deny") {
      return false;
    }
  }
  return true;
}

// -- Agent loop: same as s02, with checkPermission() inserted --

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
      if (block.type !== "tool_use") {
        continue;
      }

      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      // s03 change: run through permission pipeline before executing
      if (!(await checkPermission(block))) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: "Permission denied." });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(block.input) : `Unknown: ${block.name}`;
      console.log(String(output).slice(0, 200));
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }

    messages.push({ role: "user", content: results });
  }
}

async function main(): Promise<void> {
  console.log("s03: Permission");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
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
