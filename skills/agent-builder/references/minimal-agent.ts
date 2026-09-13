#!/usr/bin/env node
/**
 * Minimal Agent Template - Copy and customize this.
 *
 * This is the simplest possible working agent (~80 lines).
 * It has everything you need: 3 tools + loop.
 *
 * Usage:
 *     1. Set ANTHROPIC_API_KEY environment variable
 *     2. node minimal-agent.js  (or: ts-node minimal-agent.ts)
 *     3. Type commands, 'q' to quit
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// Configuration
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL_NAME || "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();

// System prompt - keep it simple
const SYSTEM = `You are a coding agent at ${WORKDIR}.

Rules:
- Use tools to complete tasks
- Prefer action over explanation
- Summarize what you did when done`;

// Minimal tool set - add more as needed
const TOOLS: any[] = [
  {
    name: "bash",
    description: "Run shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
];

/** Execute a tool and return result. */
function executeTool(name: string, args: Record<string, any>): string {
  if (name === "bash") {
    try {
      const out = execSync(args["command"], {
        cwd: WORKDIR,
        encoding: "utf-8",
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return out.trim() || "(empty)";
    } catch (e: any) {
      // Timeout or non-zero exit; combine any captured output.
      const combined = ((e.stdout || "") + (e.stderr || "")).trim();
      if (e.code === "ETIMEDOUT") {
        return "Error: Timeout";
      }
      return combined || "(empty)";
    }
  }

  if (name === "read_file") {
    try {
      return fs.readFileSync(path.join(WORKDIR, args["path"]), "utf-8").slice(0, 50000);
    } catch (e: any) {
      return `Error: ${e}`;
    }
  }

  if (name === "write_file") {
    try {
      const p = path.join(WORKDIR, args["path"]);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args["content"]);
      return `Wrote ${args["content"].length} bytes to ${args["path"]}`;
    } catch (e: any) {
      return `Error: ${e}`;
    }
  }

  return `Unknown tool: ${name}`;
}

/** Run the agent loop. */
async function agent(prompt: string, history: any[] = []): Promise<string> {
  history.push({ role: "user", content: prompt });

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: history,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // Build assistant message
    history.push({ role: "assistant", content: response.content });

    // If no tool calls, return text
    if (response.stop_reason !== "tool_use") {
      return response.content
        .filter((b: any) => "text" in b)
        .map((b: any) => b.text)
        .join("");
    }

    // Execute tools
    const results: any[] = [];
    for (const block of response.content as any[]) {
      if (block.type === "tool_use") {
        console.log(`> ${block.name}: ${JSON.stringify(block.input)}`);
        const output = executeTool(block.name, block.input);
        console.log(`  ${output.slice(0, 100)}...`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    history.push({ role: "user", content: results });
  }
}

async function main() {
  console.log(`Minimal Agent - ${WORKDIR}`);
  console.log("Type 'q' to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = (await question(">> ")).trim();
    } catch {
      break;
    }
    if (["q", "quit", "exit", ""].includes(query)) {
      break;
    }
    console.log(await agent(query, history));
    console.log();
  }
  rl.close();
}

if (require.main === module) {
  main();
}
