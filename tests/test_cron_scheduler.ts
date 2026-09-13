import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as threading from "threading"; // Python: import threading
import * as time from "time";
import * as types from "types";
import * as path from "path"; // Python: from pathlib import Path
// from datetime import datetime —— TS 使用内置 Date
// from unittest.mock import patch —— 使用等价的 mock 写法
// import pytest —— 使用等价测试框架

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// LESSON = ROOT / "s12_cron_scheduler" / "code.py"
const LESSON: string = path.join(ROOT, "s12_cron_scheduler", "code.py");

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
  const module_name: string = `cron_scheduler_test_${time.time_ns()}`;
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

// def test_s12_keeps_the_s04_kernel_and_adds_three_cron_tools():
test("test_s12_keeps_the_s04_kernel_and_adds_three_cron_tools", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);

    expect(lesson.TOOLS.map((tool: any) => tool["name"])).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "schedule_cron",
      "list_crons",
      "cancel_cron",
    ]);
    expect(new Set(lesson.HOOKS)).toEqual(
      new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"])
    );
    expect("Task" in lesson).toBe(false);
    expect("MEMORY_DIR" in lesson).toBe(false);
    expect("background_tasks" in lesson).toBe(false);
  });
});

// def test_import_does_not_start_runtime_threads():
test("test_import_does_not_start_runtime_threads", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);

    expect(lesson.runtime_started).toBeFalsy();
    expect(lesson.runtime_threads).toEqual([]);
    expect(
      threading
        .enumerate()
        .some((thread: any) =>
          new Set(["cron-scheduler", "cron-queue-processor"]).has(thread.name)
        )
    ).toBe(false);
  });
});

// def test_cron_validation_and_matching():
test("test_cron_validation_and_matching", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    // monday_at_nine = datetime(2026, 8, 10, 9, 0)  (月份从 0 起,故为 7)
    const monday_at_nine: Date = new Date(2026, 7, 10, 9, 0);

    expect(lesson.validate_cron("0 9 * * 1-5")).toBeNull();
    expect(lesson.cron_matches("0 9 * * 1-5", monday_at_nine)).toBeTruthy();
    expect(lesson.cron_matches("30 9 * * 1-5", monday_at_nine)).toBeFalsy();
    expect(lesson.validate_cron("0 24 * * *")).toContain("hour");
    expect(lesson.validate_cron("0 9 * *")).toContain("Expected 5 fields");
  });
});

// def test_schedule_retries_id_collisions_and_rolls_back_failed_persistence(monkeypatch):
test("test_schedule_retries_id_collisions_and_rolls_back_failed_persistence", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    // values = iter(["deadbeef", "deadbeef", "cafebabe", "bad0cafe"])
    const values: string[] = ["deadbeef", "deadbeef", "cafebabe", "bad0cafe"];
    let valueIndex = 0;
    // monkeypatch.setattr(lesson.secrets, "token_hex", lambda _size: next(values))
    lesson.secrets.token_hex = (_size: number): string => values[valueIndex++];

    const first: any = lesson.schedule_job("0 9 * * *", "first", { durable: false });
    const second: any = lesson.schedule_job("0 10 * * *", "second", { durable: false });
    expect(first.id).toBe("cron_deadbeef");
    expect(second.id).toBe("cron_cafebabe");

    // monkeypatch.setattr(lesson, "save_durable_jobs", lambda: ... throw OSError("disk full"))
    lesson.save_durable_jobs = (): never => {
      throw new Error("disk full"); // OSError
    };
    // with pytest.raises(OSError, match="disk full"):
    expect(() => lesson.schedule_job("0 11 * * *", "third", { durable: true })).toThrow(
      "disk full"
    );
    expect("cron_bad0cafe" in lesson.scheduled_jobs).toBe(false);
  });
});

// def test_failed_model_call_restores_delivery_without_duplicate_message():
test("test_failed_model_call_restores_delivery_without_duplicate_message", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    const job: any = new lesson.CronJob({
      id: "cron_retry",
      cron: "* * * * *",
      prompt: "retry the report",
      recurring: false,
      durable: true,
      pending_delivery: true,
    });
    lesson.scheduled_jobs[job.id] = job;
    lesson.cron_queue.push(job);
    lesson.save_durable_jobs();
    lesson.client.messages.create = (..._: any[]): never => {
      throw new Error("offline"); // RuntimeError
    };

    const messages: any[] = [];
    lesson.agent_loop(messages);

    expect(messages).toEqual([]);
    expect(lesson.cron_queue.map((queued: any) => queued.id)).toEqual([job.id]);
    expect(job.id in lesson.scheduled_jobs).toBe(true);
  });
});

// def test_scheduled_turn_never_reads_interactive_permission_input():
test("test_scheduled_turn_never_reads_interactive_permission_input", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    const block: any = types.SimpleNamespace({
      name: "bash",
      input: { command: "rm build.log" },
    });
    const results: any[] = [];

    // with patch("builtins.input", side_effect=AssertionError("input called")):
    const restore = patchBuiltinInput(() => {
      throw new Error("input called"); // AssertionError
    });
    try {
      const thread = new threading.Thread({
        target: () => results.push(lesson.permission_hook(block)),
      });
      thread.start();
      thread.join(1);
    } finally {
      restore();
    }

    expect(results).toEqual([
      "Permission denied: scheduled turns cannot request interactive approval",
    ]);
  });
});

// def test_corrupt_durable_store_reports_an_error(capsys):
test("test_corrupt_durable_store_reports_an_error", (): void => {
  tempfile.TemporaryDirectory((tmp: string): void => {
    const lesson: any = load_lesson(tmp);
    // lesson.DURABLE_PATH.write_text("{broken")
    require("fs").writeFileSync(lesson.DURABLE_PATH, "{broken");

    const captured = captureStdout(() => {
      lesson.load_durable_jobs();
    });

    expect(captured.out).toContain("could not load .scheduled_tasks.json");
    expect(lesson.scheduled_jobs).toEqual({});
  });
});

// def test_s12_code_is_ascii():
test("test_s12_code_is_ascii", (): void => {
  require("fs").readFileSync(LESSON, "ascii");
});

// ---- 辅助函数(对应 Python 的 patch / capsys),无运行要求,仅表达语义 ----
function patchBuiltinInput(_sideEffect: () => any): () => void {
  // 模拟 patch("builtins.input", ...);返回还原函数
  return () => {};
}
function captureStdout(fn: () => void): { out: string } {
  // 模拟 pytest 的 capsys.readouterr()
  fn();
  return { out: "" };
}
