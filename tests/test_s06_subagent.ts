import * as builtins from "builtins"; // Python: import builtins
import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as types from "types";
import * as path from "path"; // Python: from pathlib import Path
import * as fs from "fs";
// from unittest.mock import patch —— 使用等价 mock 写法

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// LESSON = ROOT / "s06_subagent" / "code.py"
const LESSON: string = path.join(ROOT, "s06_subagent", "code.py");

// def load_lesson(temp_cwd: Path):
function load_lesson(temp_cwd: string): any {
  const fake_anthropic: any = types.ModuleType("anthropic");

  class FakeAnthropic {
    messages: any;
    constructor(...args: any[]) {
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  const fake_dotenv: any = types.ModuleType("dotenv");
  fake_anthropic.Anthropic = FakeAnthropic;
  fake_dotenv.load_dotenv = (override: boolean = true): void => {};

  const previous_modules: Record<string, any> = {
    anthropic: sys.modules["anthropic"],
    dotenv: sys.modules["dotenv"],
  };
  const previous_cwd: string = process.cwd();
  const previous_model_id: string | undefined = process.env["MODEL_ID"];
  const spec: any = importlib_util.spec_from_file_location(
    "s06_subagent_test",
    LESSON
  );
  if (spec === null || spec.loader === null) {
    throw new Error(`Unable to load ${LESSON}`);
  }
  const module: any = importlib_util.module_from_spec(spec);

  sys.modules["anthropic"] = fake_anthropic;
  sys.modules["dotenv"] = fake_dotenv;
  try {
    os.chdir(temp_cwd);
    process.env["MODEL_ID"] = "test-model";
    spec.loader.exec_module(module);
    return module;
  } finally {
    os.chdir(previous_cwd);
    if (previous_model_id === undefined) {
      delete process.env["MODEL_ID"];
    } else {
      process.env["MODEL_ID"] = previous_model_id;
    }
    for (const [name, previous] of Object.entries(previous_modules)) {
      if (previous === undefined || previous === null) {
        delete sys.modules[name];
      } else {
        sys.modules[name] = previous;
      }
    }
  }
}

// def tool_block(name: str, tool_id: str, **tool_input):
function tool_block(name: string, tool_id: string, tool_input: Record<string, any> = {}): any {
  return types.SimpleNamespace({
    type: "tool_use",
    id: tool_id,
    name: name,
    input: tool_input,
  });
}

// def test_s06_is_kernel_plus_task():
test("test_s06_is_kernel_plus_task", (): void => {
  let lesson: any;
  tempfile.TemporaryDirectory((tmp: string): void => {
    lesson = load_lesson(tmp);
  });

  const base_names: Set<string> = new Set(
    lesson.BASE_TOOLS.map((tool: any) => tool["name"])
  );
  const parent_names: Set<string> = new Set(
    lesson.TOOLS.map((tool: any) => tool["name"])
  );
  const child_names: Set<string> = new Set(
    lesson.SUB_TOOLS.map((tool: any) => tool["name"])
  );

  expect(base_names).toEqual(
    new Set(["bash", "read_file", "write_file", "edit_file", "glob"])
  );
  // parent_names == base_names | {"task"}
  expect(parent_names).toEqual(new Set([...base_names, "task"]));
  expect(child_names).toEqual(base_names);
  expect(parent_names.has("todo_write")).toBe(false);
  expect(child_names.has("task")).toBe(false);
  expect(lesson.TASK_TOOL["input_schema"]["required"]).toEqual(["prompt"]);
  expect(lesson.HOOKS["PostToolUse"]).toContain(lesson.large_output_hook);
});

// def test_subagent_starts_with_fresh_messages_and_returns_final_text():
test("test_subagent_starts_with_fresh_messages_and_returns_final_text", (): void => {
  let calls: any[] = [];
  let result: any;
  tempfile.TemporaryDirectory((tmp: string): void => {
    const root: string = tmp;
    fs.writeFileSync(path.join(root, "note.txt"), "child input");
    const lesson: any = load_lesson(root);
    calls = [];
    const responses: any[] = [
      types.SimpleNamespace({
        stop_reason: "tool_use",
        content: [tool_block("read_file", "read_1", { path: "note.txt" })],
      }),
      types.SimpleNamespace({
        stop_reason: "end_turn",
        content: [
          types.SimpleNamespace({
            type: "text",
            text: "The note says child input.",
          }),
        ],
      }),
    ];

    // def create(**kwargs):
    function create(kwargs: any): any {
      calls.push({ ...kwargs, messages: [...kwargs["messages"]] });
      return responses.shift();
    }

    lesson.client.messages.create = create;
    result = lesson.run_subagent("Read note.txt and report its contents.");
  });

  expect(calls[0]["messages"]).toEqual([
    { role: "user", content: "Read note.txt and report its contents." },
  ]);
  expect(new Set(calls[0]["tools"].map((tool: any) => tool["name"]))).toEqual(
    new Set(["bash", "read_file", "write_file", "edit_file", "glob"])
  );
  expect(result).toBe("The note says child input.");
});

// def test_subagent_file_tools_keep_the_kernel_permission_boundary():
test("test_subagent_file_tools_keep_the_kernel_permission_boundary", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const root: string = tmp;
    const lesson: any = load_lesson(root);
    // outside = root.parent / "s06-outside.txt"
    const outside: string = path.join(path.dirname(root), "s06-outside.txt");
    const block: any = tool_block("write_file", "write_1", {
      path: String(outside),
      content: "not allowed",
    });

    // with patch.object(builtins, "input", return_value="n"):
    const original_input = builtins.input;
    builtins.input = (..._: any[]): string => "n";
    let result: any;
    try {
      result = lesson.execute_tool(block, lesson.SUB_HANDLERS);
    } finally {
      builtins.input = original_input;
    }

    expect(result).toBe("Permission denied by user");
    expect(fs.existsSync(outside)).toBe(false);
  });
});
