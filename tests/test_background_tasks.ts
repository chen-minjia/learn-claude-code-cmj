import * as copy from "copy"; // Python: import copy —— 使用深拷贝语义占位
import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile"; // Python: import tempfile
import * as time from "time";
import * as types from "types"; // Python: import types (SimpleNamespace 等)
import * as path from "path"; // Python: from pathlib import Path

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// LESSON = ROOT / "s11_background_tasks" / "code.py"
const LESSON: string = path.join(ROOT, "s11_background_tasks", "code.py");

// def load_lesson(workdir: Path):
function load_lesson(workdir: string): any {
  // fake_anthropic = types.ModuleType("anthropic")
  const fake_anthropic: any = types.ModuleType("anthropic");

  // class FakeAnthropic:
  class FakeAnthropic {
    messages: any;
    constructor(...args: any[]) {
      // self.messages = types.SimpleNamespace(create=None)
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  // fake_dotenv = types.ModuleType("dotenv")
  const fake_dotenv: any = types.ModuleType("dotenv");
  fake_anthropic.Anthropic = FakeAnthropic;
  fake_dotenv.load_dotenv = (override: boolean = true): void => {};

  // previous_modules = {...}
  const previous_modules: Record<string, any> = {
    anthropic: sys.modules["anthropic"],
    dotenv: sys.modules["dotenv"],
  };
  const previous_cwd: string = process.cwd();
  const previous_model: string | undefined = process.env["MODEL_ID"];
  // module_name = f"background_tasks_test_{time.time_ns()}"
  const module_name: string = `background_tasks_test_${time.time_ns()}`;
  const spec: any = importlib_util.spec_from_file_location(module_name, LESSON);
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

// def wait_until(predicate, timeout: float = 2.0) -> bool:
function wait_until(predicate: () => boolean, timeout: number = 2.0): boolean {
  const deadline: number = time.monotonic() + timeout;
  while (time.monotonic() < deadline) {
    if (predicate()) {
      return true;
    }
    time.sleep(0.01);
  }
  return false;
}

// def test_s11_keeps_the_s04_kernel_and_adds_one_bash_option():
test("test_s11_keeps_the_s04_kernel_and_adds_one_bash_option", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);

    // assert {tool["name"] for tool in lesson.TOOLS} == {...}
    expect(new Set(lesson.TOOLS.map((tool: any) => tool["name"]))).toEqual(
      new Set(["bash", "read_file", "write_file", "edit_file", "glob"])
    );
    const bash: any = lesson.TOOLS.find((tool: any) => tool["name"] === "bash");
    expect("run_in_background" in bash["input_schema"]["properties"]).toBe(true);
    expect(new Set(lesson.HOOKS)).toEqual(
      new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"])
    );
    expect("Task" in lesson).toBe(false);
    expect("MEMORY_DIR" in lesson).toBe(false);
  });
});

// def test_background_execution_requires_an_explicit_bash_flag():
test("test_background_execution_requires_an_explicit_bash_flag", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);

    expect(lesson.should_run_background("bash", { command: "npm install" })).toBeFalsy();
    expect(
      lesson.should_run_background("bash", {
        command: "printf ready",
        run_in_background: true,
      })
    ).toBeTruthy();
    expect(
      lesson.should_run_background("write_file", { run_in_background: true })
    ).toBeFalsy();
  });
});

// def test_background_bash_passes_permission_before_dispatch():
test("test_background_bash_passes_permission_before_dispatch", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    const block: any = types.SimpleNamespace({
      id: "tool_denied",
      name: "bash",
      input: { command: "rm -rf /tmp/example", run_in_background: true },
      type: "tool_use",
    });
    const responses: any[] = [
      types.SimpleNamespace({ stop_reason: "tool_use", content: [block] }),
      types.SimpleNamespace({
        stop_reason: "end_turn",
        content: [types.SimpleNamespace({ type: "text", text: "Denied." })],
      }),
    ];
    lesson.client.messages.create = (..._: any[]): any => responses.shift();
    const history: any[] = [{ role: "user", content: "Delete the directory" }];

    lesson.agent_loop(history);

    expect(lesson.background_tasks).toBeFalsy();
    const result: any = history[2]["content"][0];
    expect(result["type"]).toBe("tool_result");
    expect(result["content"]).toContain("Permission denied");
  });
});

// def test_completed_result_is_collected_once_before_a_later_llm_call():
test("test_completed_result_is_collected_once_before_a_later_llm_call", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    const block: any = types.SimpleNamespace({
      id: "tool_ready",
      name: "bash",
      input: { command: "printf ready", run_in_background: true },
    });
    const task_id: string = lesson.start_background_task(block);
    expect(
      wait_until(
        () => lesson.background_tasks[task_id]["status"] === "completed"
      )
    ).toBe(true);

    const seen_messages: any[] = [];

    // def respond(**kwargs):
    function respond(kwargs: any): any {
      seen_messages.push(copy.deepcopy(kwargs["messages"]));
      return types.SimpleNamespace({
        stop_reason: "end_turn",
        content: [types.SimpleNamespace({ type: "text", text: "Received." })],
      });
    }

    lesson.client.messages.create = respond;
    const history: any[] = [{ role: "user", content: "Continue" }];
    lesson.agent_loop(history);

    const delivered: string = String(seen_messages[0]);
    expect(delivered).toContain("<task_notification>");
    expect(delivered).toContain(`<task_id>${task_id}</task_id>`);
    expect(delivered).toContain("<status>completed</status>");
    expect(delivered).toContain("ready");
    expect(lesson.collect_background_results()).toEqual([]);
  });
});

// def test_s11_code_is_ascii():
test("test_s11_code_is_ascii", (): void => {
  // LESSON.read_text(encoding="ascii")
  require("fs").readFileSync(LESSON, "ascii");
});
