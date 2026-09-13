#!/usr/bin/env node
// Harness: on-demand knowledge -- domain expertise, loaded when the model asks.
/**
 * s05_skill_loading.ts - Skills
 *
 * Two-layer skill injection that avoids bloating the system prompt:
 *
 *     Layer 1 (cheap): skill names in system prompt (~100 tokens/skill)
 *     Layer 2 (on demand): full skill body in tool_result
 *
 *     skills/
 *       pdf/
 *         SKILL.md          <-- frontmatter (name, description) + body
 *       code-review/
 *         SKILL.md
 *
 *     System prompt:
 *     +--------------------------------------+
 *     | You are a coding agent.              |
 *     | Skills available:                    |
 *     |   - pdf: Process PDF files...        |  <-- Layer 1: metadata only
 *     |   - code-review: Review code...      |
 *     +--------------------------------------+
 *
 *     When model calls load_skill("pdf"):
 *     +--------------------------------------+
 *     | tool_result:                         |
 *     | <skill>                              |
 *     |   Full PDF processing instructions   |  <-- Layer 2: full body
 *     |   Step 1: ...                        |
 *     |   Step 2: ...                        |
 *     | </skill>                             |
 *     +--------------------------------------+
 *
 * Key insight: "Don't put everything in the system prompt. Load on demand."
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

// YAML parser: npm install js-yaml
import * as yaml from "js-yaml";

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID as string;
const SKILLS_DIR = path.join(WORKDIR, "skills");

interface Skill {
  meta: Record<string, any>;
  body: string;
  path: string;
}

// Recursively find all SKILL.md files under a directory.
function rglobSkillMd(dir: string): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...rglobSkillMd(full));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      found.push(full);
    }
  }
  return found;
}

// -- SkillLoader: scan skills/<name>/SKILL.md with YAML frontmatter --
class SkillLoader {
  skills_dir: string;
  skills: Record<string, Skill>;

  constructor(skills_dir: string) {
    this.skills_dir = skills_dir;
    this.skills = {};
    this._load_all();
  }

  _load_all(): void {
    if (!fs.existsSync(this.skills_dir)) {
      return;
    }
    for (const f of rglobSkillMd(this.skills_dir).sort()) {
      const text = fs.readFileSync(f, "utf-8");
      const [meta, body] = this._parse_frontmatter(text);
      const name = meta["name"] ?? path.basename(path.dirname(f));
      this.skills[name] = { meta, body, path: f };
    }
  }

  /** Parse YAML frontmatter between --- delimiters. */
  _parse_frontmatter(text: string): [Record<string, any>, string] {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
    if (!match) {
      return [{}, text];
    }
    let meta: Record<string, any>;
    try {
      meta = (yaml.load(match[1]) as Record<string, any>) || {};
    } catch {
      meta = {};
    }
    return [meta, match[2].trim()];
  }

  /** Layer 1: short descriptions for the system prompt. */
  get_descriptions(): string {
    if (Object.keys(this.skills).length === 0) {
      return "(no skills available)";
    }
    const lines: string[] = [];
    for (const [name, skill] of Object.entries(this.skills)) {
      const desc = skill.meta["description"] ?? "No description";
      const tags = skill.meta["tags"] ?? "";
      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  /** Layer 2: full skill body returned in tool_result. */
  get_content(name: string): string {
    const skill = this.skills[name];
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(
        this.skills
      ).join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// Layer 1: skill metadata injected into system prompt
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.get_descriptions()}`;

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
  load_skill: (kw) => SKILL_LOADER.get_content(kw["name"]),
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
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
    },
  },
];

async function agent_loop(messages: any[]): Promise<void> {
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
      return;
    }
    const results: any[] = [];
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
      }
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
      query = await ask("\x1b[36ms05 >> \x1b[0m");
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
