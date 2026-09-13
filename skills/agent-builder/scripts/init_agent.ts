#!/usr/bin/env node
/**
 * Agent Scaffold Script - Create a new agent project with best practices.
 *
 * Usage:
 *     node init_agent.js <agent-name> [--level 0-4] [--path <output-dir>]
 *
 * Examples:
 *     node init_agent.js my-agent                 // Level 1 (4 tools)
 *     node init_agent.js my-agent --level 0       // Minimal (bash only)
 *     node init_agent.js my-agent --level 2       // With TodoWrite
 *     node init_agent.js my-agent --path ./bots   // Custom output directory
 */

import * as fs from "fs";
import * as path from "path";

// Agent templates for each level.
// Note: the original Python templates generated Python agents. They are kept
// verbatim here (as string templates) so the scaffold output stays identical.
// `{name}` placeholders are substituted via the `format` helper below.
const TEMPLATES: Record<number, string> = {
  0: `#!/usr/bin/env python3
"""
Level 0 Agent - Bash is All You Need (~50 lines)

Core insight: One tool (bash) can do everything.
Subagents via self-recursion: python {name}.py "subtask"
"""

from anthropic import Anthropic
from dotenv import load_dotenv
import subprocess
import os

load_dotenv()

client = Anthropic(
    api_key=os.getenv("ANTHROPIC_API_KEY"),
    base_url=os.getenv("ANTHROPIC_BASE_URL")
)
MODEL = os.getenv("MODEL_NAME", "claude-sonnet-4-20250514")

SYSTEM = """You are a coding agent. Use bash for everything:
- Read: cat, grep, find, ls
- Write: echo 'content' > file
- Subagent: python {name}.py "subtask"
"""

TOOL = [{{
    "name": "bash",
    "description": "Execute shell command",
    "input_schema": {{"type": "object", "properties": {{"command": {{"type": "string"}}}}, "required": ["command"]}}
}}]

def run(prompt, history=[]):
    history.append({{"role": "user", "content": prompt}})
    while True:
        r = client.messages.create(model=MODEL, system=SYSTEM, messages=history, tools=TOOL, max_tokens=8000)
        history.append({{"role": "assistant", "content": r.content}})
        if r.stop_reason != "tool_use":
            return "".join(b.text for b in r.content if hasattr(b, "text"))
        results = []
        for b in r.content:
            if b.type == "tool_use":
                print(f"> {{b.input['command']}}")
                try:
                    out = subprocess.run(b.input["command"], shell=True, capture_output=True, text=True, timeout=60)
                    output = (out.stdout + out.stderr).strip() or "(empty)"
                except Exception as e:
                    output = f"Error: {{e}}"
                results.append({{"type": "tool_result", "tool_use_id": b.id, "content": output[:50000]}})
        history.append({{"role": "user", "content": results}})

if __name__ == "__main__":
    h = []
    print("{name} - Level 0 Agent\\nType 'q' to quit.\\n")
    while (q := input(">> ").strip()) not in ("q", "quit", ""):
        print(run(q, h), "\\n")
`,

  1: `#!/usr/bin/env python3
"""
Level 1 Agent - Model as Agent (~200 lines)

Core insight: 4 tools cover 90% of coding tasks.
The model IS the agent. Code just runs the loop.
"""

from anthropic import Anthropic
from dotenv import load_dotenv
from pathlib import Path
import subprocess
import os

load_dotenv()

client = Anthropic(
    api_key=os.getenv("ANTHROPIC_API_KEY"),
    base_url=os.getenv("ANTHROPIC_BASE_URL")
)
MODEL = os.getenv("MODEL_NAME", "claude-sonnet-4-20250514")
WORKDIR = Path.cwd()

SYSTEM = f"""You are a coding agent at {{WORKDIR}}.

Rules:
- Prefer tools over prose. Act, don't just explain.
- Never invent file paths. Use ls/find first if unsure.
- Make minimal changes. Don't over-engineer.
- After finishing, summarize what changed."""

TOOLS = [
    {{"name": "bash", "description": "Run shell command",
     "input_schema": {{"type": "object", "properties": {{"command": {{"type": "string"}}}}, "required": ["command"]}}}},
    {{"name": "read_file", "description": "Read file contents",
     "input_schema": {{"type": "object", "properties": {{"path": {{"type": "string"}}}}, "required": ["path"]}}}},
    {{"name": "write_file", "description": "Write content to file",
     "input_schema": {{"type": "object", "properties": {{"path": {{"type": "string"}}, "content": {{"type": "string"}}}}, "required": ["path", "content"]}}}},
    {{"name": "edit_file", "description": "Replace exact text in file",
     "input_schema": {{"type": "object", "properties": {{"path": {{"type": "string"}}, "old_text": {{"type": "string"}}, "new_text": {{"type": "string"}}}}, "required": ["path", "old_text", "new_text"]}}}},
]

def safe_path(p: str) -> Path:
    """Prevent path escape attacks."""
    path = (WORKDIR / p).resolve()
    if not path.is_relative_to(WORKDIR):
        raise ValueError(f"Path escapes workspace: {{p}}")
    return path

def execute(name: str, args: dict) -> str:
    """Execute a tool and return result."""
    if name == "bash":
        dangerous = ["rm -rf /", "sudo", "shutdown", "> /dev/"]
        if any(d in args["command"] for d in dangerous):
            return "Error: Dangerous command blocked"
        try:
            r = subprocess.run(args["command"], shell=True, cwd=WORKDIR, capture_output=True, text=True, timeout=60)
            return (r.stdout + r.stderr).strip()[:50000] or "(empty)"
        except subprocess.TimeoutExpired:
            return "Error: Timeout (60s)"
        except Exception as e:
            return f"Error: {{e}}"

    if name == "read_file":
        try:
            return safe_path(args["path"]).read_text()[:50000]
        except Exception as e:
            return f"Error: {{e}}"

    if name == "write_file":
        try:
            p = safe_path(args["path"])
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(args["content"])
            return f"Wrote {{len(args['content'])}} bytes to {{args['path']}}"
        except Exception as e:
            return f"Error: {{e}}"

    if name == "edit_file":
        try:
            p = safe_path(args["path"])
            content = p.read_text()
            if args["old_text"] not in content:
                return f"Error: Text not found in {{args['path']}}"
            p.write_text(content.replace(args["old_text"], args["new_text"], 1))
            return f"Edited {{args['path']}}"
        except Exception as e:
            return f"Error: {{e}}"

    return f"Unknown tool: {{name}}"

def agent(prompt: str, history: list = None) -> str:
    """Run the agent loop."""
    if history is None:
        history = []
    history.append({{"role": "user", "content": prompt}})

    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=history, tools=TOOLS, max_tokens=8000
        )
        history.append({{"role": "assistant", "content": response.content}})

        if response.stop_reason != "tool_use":
            return "".join(b.text for b in response.content if hasattr(b, "text"))

        results = []
        for block in response.content:
            if block.type == "tool_use":
                print(f"> {{block.name}}: {{str(block.input)[:100]}}")
                output = execute(block.name, block.input)
                print(f"  {{output[:100]}}...")
                results.append({{"type": "tool_result", "tool_use_id": block.id, "content": output}})
        history.append({{"role": "user", "content": results}})

if __name__ == "__main__":
    print(f"{name} - Level 1 Agent at {{WORKDIR}}")
    print("Type 'q' to quit.\\n")
    h = []
    while True:
        try:
            query = input(">> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if query in ("q", "quit", "exit", ""):
            break
        print(agent(query, h), "\\n")
`,
};

const ENV_TEMPLATE = `# API Configuration
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.anthropic.com
MODEL_NAME=claude-sonnet-4-20250514
`;

/**
 * Replicates Python str.format(name=...) for the templates above.
 * `{{` / `}}` become literal braces, and `{name}` is substituted.
 */
function formatTemplate(template: string, name: string): string {
  return template
    .replace(/\{\{/g, "\u0000LB\u0000")
    .replace(/\}\}/g, "\u0000RB\u0000")
    .replace(/\{name\}/g, name)
    .replace(/\u0000LB\u0000/g, "{")
    .replace(/\u0000RB\u0000/g, "}");
}

/** Create a new agent project. */
function createAgent(name: string, level: number, outputDir: string): void {
  // Validate level
  if (!(level in TEMPLATES) && ![2, 3, 4].includes(level)) {
    console.log(`Error: Level ${level} not yet implemented in scaffold.`);
    console.log("Available levels: 0 (minimal), 1 (4 tools)");
    console.log("For levels 2-4, copy from mini-claude-code repository.");
    process.exit(1);
  }

  // Create output directory
  const agentDir = path.join(outputDir, name);
  fs.mkdirSync(agentDir, { recursive: true });

  // Write agent file
  const agentFile = path.join(agentDir, `${name}.py`);
  const template = TEMPLATES[level] ?? TEMPLATES[1];
  fs.writeFileSync(agentFile, formatTemplate(template, name));
  console.log(`Created: ${agentFile}`);

  // Write .env.example
  const envFile = path.join(agentDir, ".env.example");
  fs.writeFileSync(envFile, ENV_TEMPLATE);
  console.log(`Created: ${envFile}`);

  // Write .gitignore
  const gitignore = path.join(agentDir, ".gitignore");
  fs.writeFileSync(gitignore, ".env\n__pycache__/\n*.pyc\n");
  console.log(`Created: ${gitignore}`);

  console.log(`\nAgent '${name}' created at ${agentDir}`);
  console.log(`\nNext steps:`);
  console.log(`  1. cd ${agentDir}`);
  console.log(`  2. cp .env.example .env`);
  console.log(`  3. Edit .env with your API key`);
  console.log(`  4. pip install anthropic python-dotenv`);
  console.log(`  5. python ${name}.py`);
}

function main(): void {
  // Minimal argument parser (mirrors Python argparse behavior for this script).
  const argv = process.argv.slice(2);

  let name: string | undefined;
  let level = 1;
  let outputDir = process.cwd();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--level") {
      level = parseInt(argv[++i], 10);
      if (![0, 1, 2, 3, 4].includes(level)) {
        console.log("Error: --level must be one of 0, 1, 2, 3, 4");
        process.exit(2);
      }
    } else if (arg === "--path") {
      outputDir = argv[++i];
    } else if (!arg.startsWith("--")) {
      name = arg;
    }
  }

  if (!name) {
    console.log("Usage: node init_agent.js <agent-name> [--level 0-4] [--path <output-dir>]");
    process.exit(2);
  }

  createAgent(name, level, outputDir);
}

if (require.main === module) {
  main();
}
