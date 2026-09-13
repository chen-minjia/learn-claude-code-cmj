#!/usr/bin/env node
/**
 * s07_skill_loading.ts - Skill Loading
 *
 * The system prompt contains a catalog of skill names and descriptions.
 * The model loads the full SKILL.md only when it calls load_skill.
 *
 *     skills/                    Startup
 *     +------------------+       +------------------+
 *     | code-review/     | ----> | SkillLoader      |
 *     |   SKILL.md       |       | name + summary   |
 *     | pdf/             |       +--------+---------+
 *     |   SKILL.md       |                |
 *     +------------------+                v
 *                                  system prompt catalog
 *
 *     LLM -- load_skill(name) --> full SKILL.md
 *      ^                              |
 *      +--------- tool_result --------+
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";
import { globSync } from "glob";
import * as yaml from "js-yaml";

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const SKILLS_DIR = path.join(WORKDIR, "skills");
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID as string;

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

// -- Skill catalog --

interface Skill {
  name: string;
  description: string;
  content: string;
}

class SkillLoader {
  skillsDir: string;
  skills: Record<string, Skill> = {};

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.scan();
  }

  static parseFrontmatter(text: string): [Record<string, any>, string] {
    if (!text.startsWith("---")) {
      return [{}, text];
    }
    const parts = text.split("---");
    // Python's text.split("---", 2) keeps the remainder joined; mimic that here.
    if (parts.length < 3) {
      return [{}, text];
    }
    const front = parts[1];
    const body = parts.slice(2).join("---");
    let metadata: any;
    try {
      metadata = yaml.load(front) || {};
    } catch {
      metadata = {};
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      metadata = {};
    }
    return [metadata, body.replace(/^\s+/, "")];
  }

  scan(): void {
    this.skills = {};
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }

    const manifests = globSync("*/SKILL.md", { cwd: this.skillsDir }).sort();
    for (const rel of manifests) {
      const manifest = path.join(this.skillsDir, rel);
      const content = fs.readFileSync(manifest, "utf-8");
      const [metadata, body] = SkillLoader.parseFrontmatter(content);
      const parentName = path.basename(path.dirname(manifest));
      const name = String(metadata.name || parentName).trim();
      let description = metadata.description || body.split("\n")[0];
      description = String(description).replace(/^#+\s*/, "").split(/\s+/).join(" ");
      this.skills[name] = {
        name,
        description,
        content,
      };
    }
  }

  catalog(): string {
    const values = Object.values(this.skills);
    if (!values.length) {
      return "(no skills found)";
    }
    return values.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  }

  load(name: string): string {
    const skill = this.skills[name];
    if (skill) {
      return skill.content;
    }
    const available = Object.keys(this.skills).join(", ") || "none";
    return `Error: Unknown skill '${name}'. Available: ${available}`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

function buildSystemPrompt(): string {
  return (
    `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. ` +
    "Act, don't explain.\n\n" +
    `Skills available:\n${SKILL_LOADER.catalog()}\n\n` +
    "Use load_skill to read the full instructions when a skill applies."
  );
}

const SYSTEM = buildSystemPrompt();

// -- Tools --

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
  { name: "load_skill", description: "Load the full SKILL.md content by skill name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: (input: any) => runBash(input.command),
  read_file: (input: any) => runRead(input.path, input.limit ?? null),
  write_file: (input: any) => runWrite(input.path, input.content),
  edit_file: (input: any) => runEdit(input.path, input.old_text, input.new_text),
  glob: (input: any) => runGlob(input.pattern),
  load_skill: (input: any) => SKILL_LOADER.load(input.name),
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

async function executeTool(block: any): Promise<string> {
  const blocked = await triggerHooks("PreToolUse", block);
  if (blocked) {
    return String(blocked);
  }

  const handler = TOOL_HANDLERS[block.name];
  let output: any;
  try {
    output = handler ? handler(block.input) : `Unknown: ${block.name}`;
  } catch (e: any) {
    output = `Error: ${e}`;
  }

  await triggerHooks("PostToolUse", block, output);
  return String(output);
}

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
      const output = await executeTool(block);
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
  console.log("s07: Skill Loading - catalog first, full content on demand");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms07 >> \x1b[0m");
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
