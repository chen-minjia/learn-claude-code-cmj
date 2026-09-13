/**
 * Tool Templates - Copy and customize these for your agent.
 *
 * Each tool needs:
 * 1. Definition (JSON schema for the model)
 * 2. Implementation (TypeScript function)
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const WORKDIR = process.cwd();

// =============================================================================
// TOOL DEFINITIONS (for TOOLS list)
// =============================================================================

const BASH_TOOL = {
  name: "bash",
  description: "Run a shell command. Use for: ls, find, grep, git, npm, python, etc.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  },
};

const READ_FILE_TOOL = {
  name: "read_file",
  description: "Read file contents. Returns UTF-8 text.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file",
      },
      limit: {
        type: "integer",
        description: "Max lines to read (default: all)",
      },
    },
    required: ["path"],
  },
};

const WRITE_FILE_TOOL = {
  name: "write_file",
  description: "Write content to a file. Creates parent directories if needed.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path for the file",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
    },
    required: ["path", "content"],
  },
};

const EDIT_FILE_TOOL = {
  name: "edit_file",
  description: "Replace exact text in a file. Use for surgical edits.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file",
      },
      old_text: {
        type: "string",
        description: "Exact text to find (must match precisely)",
      },
      new_text: {
        type: "string",
        description: "Replacement text",
      },
    },
    required: ["path", "old_text", "new_text"],
  },
};

const TODO_WRITE_TOOL = {
  name: "TodoWrite",
  description: "Update the task list. Use to plan and track progress.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "Complete list of tasks",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Task description" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", description: "Present tense, e.g. 'Reading files'" },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["items"],
  },
};

const TASK_TOOL_TEMPLATE = `
// Generate dynamically with agent types
const TASK_TOOL = {
  name: "Task",
  description: \`Spawn a subagent for a focused subtask.\\n\\nAgent types:\\n\${getAgentDescriptions()}\`,
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short task name (3-5 words)" },
      prompt: { type: "string", description: "Detailed instructions" },
      agent_type: { type: "string", enum: Object.keys(AGENT_TYPES) },
    },
    required: ["description", "prompt", "agent_type"],
  },
};
`;

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

/**
 * Security: Ensure path stays within workspace.
 * Prevents ../../../etc/passwd attacks.
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/**
 * Execute shell command with safety checks.
 *
 * Safety features:
 * - Blocks obviously dangerous commands
 * - 60 second timeout
 * - Output truncated to 50KB
 */
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const out = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = out.trim();
    return output ? output.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.code === "ETIMEDOUT") {
      return "Error: Command timed out (60s)";
    }
    const combined = ((e.stdout || "") + (e.stderr || "")).trim();
    if (combined) {
      return combined.slice(0, 50000);
    }
    return `Error: ${e}`;
  }
}

/**
 * Read file contents with optional line limit.
 *
 * Features:
 * - Safe path resolution
 * - Optional line limit for large files
 * - Output truncated to 50KB
 */
function runReadFile(p: string, limit: number | null = null): string {
  try {
    const text = fs.readFileSync(safePath(p), "utf-8");
    let lines = text.split(/\r?\n/);

    if (limit && limit < lines.length) {
      const total = text.split(/\r?\n/).length;
      lines = lines.slice(0, limit);
      lines.push(`... (${total - limit} more lines)`);
    }

    return lines.join("\n").slice(0, 50000);
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

/**
 * Write content to file, creating parent directories if needed.
 *
 * Features:
 * - Safe path resolution
 * - Auto-creates parent directories
 * - Returns byte count for confirmation
 */
function runWriteFile(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

/**
 * Replace exact text in a file (surgical edit).
 *
 * Features:
 * - Exact string matching (not regex)
 * - Only replaces first occurrence (safety)
 * - Clear error if text not found
 */
function runEditFile(p: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(p);
    const content = fs.readFileSync(fp, "utf-8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${p}`;
    }

    // replace only the first occurrence
    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(fp, newContent);
    return `Edited ${p}`;
  } catch (e: any) {
    return `Error: ${e}`;
  }
}

// =============================================================================
// DISPATCHER PATTERN
// =============================================================================

/**
 * Dispatch tool call to implementation.
 *
 * This pattern makes it easy to add new tools:
 * 1. Add definition to TOOLS list
 * 2. Add implementation function
 * 3. Add case to this dispatcher
 */
function executeTool(name: string, args: Record<string, any>): string {
  if (name === "bash") {
    return runBash(args["command"]);
  }
  if (name === "read_file") {
    return runReadFile(args["path"], args["limit"]);
  }
  if (name === "write_file") {
    return runWriteFile(args["path"], args["content"]);
  }
  if (name === "edit_file") {
    return runEditFile(args["path"], args["old_text"], args["new_text"]);
  }
  // Add more tools here...
  return `Unknown tool: ${name}`;
}

export {
  BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  TODO_WRITE_TOOL,
  TASK_TOOL_TEMPLATE,
  safePath,
  runBash,
  runReadFile,
  runWriteFile,
  runEditFile,
  executeTool,
};
