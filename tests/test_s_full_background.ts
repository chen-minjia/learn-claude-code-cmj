import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as types from "types";
// import unittest —— TS 使用等价的测试框架写法
import * as path from "path"; // Python: from pathlib import Path

// REPO_ROOT = Path(__file__).resolve().parents[1]
const REPO_ROOT: string = path.resolve(__dirname, "..");
// MODULE_PATH = REPO_ROOT / "agents" / "s_full.py"
const MODULE_PATH: string = path.join(REPO_ROOT, "agents", "s_full.py");

// def load_s_full_module(temp_cwd: Path):
function load_s_full_module(temp_cwd: string): any {
  const fake_anthropic: any = types.ModuleType("anthropic");

  class FakeAnthropic {
    messages: any;
    constructor(...args: any[]) {
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  const fake_dotenv: any = types.ModuleType("dotenv");
  // setattr(fake_anthropic, "Anthropic", FakeAnthropic)
  fake_anthropic.Anthropic = FakeAnthropic;
  // setattr(fake_dotenv, "load_dotenv", lambda override=True: None)
  fake_dotenv.load_dotenv = (override: boolean = true): void => {};

  const previous_anthropic: any = sys.modules["anthropic"];
  const previous_dotenv: any = sys.modules["dotenv"];
  const previous_cwd: string = process.cwd();
  const spec: any = importlib_util.spec_from_file_location(
    "s_full_under_test",
    MODULE_PATH
  );
  if (spec === null || spec.loader === null) {
    throw new Error(`Unable to load ${MODULE_PATH}`);
  }
  const module: any = importlib_util.module_from_spec(spec);

  sys.modules["anthropic"] = fake_anthropic;
  sys.modules["dotenv"] = fake_dotenv;
  try {
    os.chdir(temp_cwd);
    // os.environ.setdefault("MODEL_ID", "test-model")
    if (!("MODEL_ID" in process.env)) {
      process.env["MODEL_ID"] = "test-model";
    }
    spec.loader.exec_module(module);
    return module;
  } finally {
    os.chdir(previous_cwd);
    if (previous_anthropic === undefined || previous_anthropic === null) {
      delete sys.modules["anthropic"];
    } else {
      sys.modules["anthropic"] = previous_anthropic;
    }
    if (previous_dotenv === undefined || previous_dotenv === null) {
      delete sys.modules["dotenv"];
    } else {
      sys.modules["dotenv"] = previous_dotenv;
    }
  }
}

// class BackgroundManagerTests(unittest.TestCase):
describe("BackgroundManagerTests", () => {
  // def test_check_returns_running_placeholder_when_result_is_none(self):
  test("test_check_returns_running_placeholder_when_result_is_none", (): void => {
    tempfile.TemporaryDirectory((tmp: string): void => {
      const module: any = load_s_full_module(tmp);
      const manager: any = new module.BackgroundManager();
      manager.tasks["abc123"] = {
        status: "running",
        command: "sleep 1",
        result: null,
      };

      expect(manager.check("abc123")).toBe("[running] (running)");
    });
  });
});

// if __name__ == "__main__": unittest.main()
