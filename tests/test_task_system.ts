import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as types from "types";
import * as path from "path"; // Python: from pathlib import Path
import * as fs from "fs";
// import pytest —— 使用等价测试框架/mock 写法

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// LESSON = ROOT / "s10_task_system" / "code.py"
const LESSON: string = path.join(ROOT, "s10_task_system", "code.py");

// def load_lesson(workdir: Path):
function load_lesson(workdir: string): any {
  const fake_anthropic: any = types.ModuleType("anthropic");
  const fake_dotenv: any = types.ModuleType("dotenv");

  class FakeAnthropic {
    messages: any;
    constructor(...args: any[]) {
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  fake_anthropic.Anthropic = FakeAnthropic;
  fake_dotenv.load_dotenv = (override: boolean = true): void => {};

  const previous_modules: Record<string, any> = {
    anthropic: sys.modules["anthropic"],
    dotenv: sys.modules["dotenv"],
  };
  const previous_cwd: string = process.cwd();
  const previous_model: string | undefined = process.env["MODEL_ID"];

  // module_name = f"s10_task_system_test_{id(workdir)}"
  const module_name: string = `s10_task_system_test_${id(workdir)}`;
  const spec: any = importlib_util.spec_from_file_location(module_name, LESSON);
  // assert spec is not None and spec.loader is not None
  expect(spec !== null && spec.loader !== null).toBe(true);
  const module: any = importlib_util.module_from_spec(spec);

  sys.modules["anthropic"] = fake_anthropic;
  sys.modules["dotenv"] = fake_dotenv;
  sys.modules[module_name] = module;
  try {
    os.chdir(workdir);
    process.env["MODEL_ID"] = "test-model";
    spec.loader.exec_module(module);
    return module;
  } finally {
    os.chdir(previous_cwd);
    delete sys.modules[module_name];
    if (previous_model === undefined) {
      delete process.env["MODEL_ID"];
    } else {
      process.env["MODEL_ID"] = previous_model;
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

// def tool_call(name: str, **arguments):
function tool_call(name: string, arguments_: Record<string, any> = {}): any {
  return types.SimpleNamespace({ name: name, input: arguments_, id: "tool-1" });
}

// def test_s10_keeps_the_s04_kernel_and_adds_task_tools() -> None:
test("test_s10_keeps_the_s04_kernel_and_adds_task_tools", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const workdir: string = tmp;
    const lesson: any = load_lesson(workdir);

    expect(lesson.TOOLS.map((tool: any) => tool["name"])).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "create_task",
      "list_tasks",
      "get_task",
      "claim_task",
      "complete_task",
    ]);
    expect(lesson.HOOKS["PreToolUse"]).toContain(lesson.permission_hook);
    expect("execute_tool" in lesson).toBe(true);
    expect("MEMORY_DIR" in lesson).toBe(false);
    expect(fs.existsSync(path.join(workdir, ".tasks"))).toBe(false);
  });
});

// def test_dependencies_gate_claim_and_completion_checks_owner() -> None:
test("test_dependencies_gate_claim_and_completion_checks_owner", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const workdir: string = tmp;
    const lesson: any = load_lesson(workdir);

    const schema: any = lesson.create_task("create schema");
    const api: any = lesson.create_task("write API", { blockedBy: [schema.id] });

    expect(lesson.claim_task(api.id)).toBe(`Blocked by: ['${schema.id}']`);
    expect(lesson.claim_task(schema.id)).toContain("Claimed");
    expect(lesson.complete_task(schema.id)).toContain("Unblocked: write API");
    expect(lesson.claim_task(api.id)).toContain("Claimed");
    expect(lesson.complete_task(api.id, { owner: "other" })).toContain(
      "owned by agent, not other"
    );
    expect(lesson.complete_task(api.id)).toContain("Completed");
    expect(lesson.load_task(api.id).status).toBe("completed");
  });
});

// def test_invalid_and_missing_task_ids_become_tool_results() -> None:
test("test_invalid_and_missing_task_ids_become_tool_results", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);

    const invalid: string = lesson.execute_tool(
      tool_call("get_task", { task_id: "../outside" })
    );
    const missing: string = lesson.execute_tool(
      tool_call("claim_task", { task_id: "task_00000000" })
    );

    expect(invalid.startsWith("Error: Invalid task ID")).toBe(true);
    expect(missing.startsWith("Error:")).toBe(true);
  });
});

// def test_create_retries_instead_of_overwriting_an_existing_id(monkeypatch) -> None:
test("test_create_retries_instead_of_overwriting_an_existing_id", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    const values: string[] = ["deadbeef", "deadbeef", "cafebabe"];
    let valueIndex = 0;
    // monkeypatch.setattr(lesson.secrets, "token_hex", lambda _size: next(values))
    lesson.secrets.token_hex = (_size: number): string => values[valueIndex++];

    const first: any = lesson.create_task("first");
    const second: any = lesson.create_task("second");

    expect(first.id).toBe("task_deadbeef");
    expect(second.id).toBe("task_cafebabe");
    expect(lesson.list_tasks().map((task: any) => task.subject)).toEqual([
      "second",
      "first",
    ]);
  });
});

// def test_create_rejects_unknown_dependencies() -> None:
test("test_create_rejects_unknown_dependencies", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);

    const output: string = lesson.execute_tool(
      tool_call("create_task", {
        subject: "write API",
        blockedBy: ["task_00000000"],
      })
    );

    expect(output).toBe("Error: Dependency not found: task_00000000");
  });
});

// def test_task_store_rejects_a_symlink_outside_the_workspace() -> None:
test("test_task_store_rejects_a_symlink_outside_the_workspace", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    tempfile.TemporaryDirectory((outside: string): void => {
      const workdir: string = tmp;
      // (workdir / ".tasks").symlink_to(Path(outside), target_is_directory=True)
      fs.symlinkSync(outside, path.join(workdir, ".tasks"), "dir");
      const lesson: any = load_lesson(workdir);

      const output: string = lesson.execute_tool(
        tool_call("create_task", { subject: "unsafe" })
      );

      expect(output).toBe("Error: Task store escapes the workspace");
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });
});

// 对应 Python 内置 id(),返回对象唯一标识(此处以近似实现表达语义)
function id(_obj: any): number {
  return 0;
}
