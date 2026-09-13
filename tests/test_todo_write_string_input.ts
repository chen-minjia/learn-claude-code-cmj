import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as os from "os";
import * as sys from "sys";
import * as tempfile from "tempfile";
import * as types from "types";
// import unittest —— TS 使用等价的测试框架写法
import * as path from "path"; // Python: from pathlib import Path

// REPO_ROOT = Path(__file__).resolve().parents[1]
const REPO_ROOT: string = path.resolve(__dirname, "..");
// COURSE_MODULES = [...]
const COURSE_MODULES: [string, string][] = [
  ["s05", path.join(REPO_ROOT, "s05_todo_write", "code.py")],
  ["s15", path.join(REPO_ROOT, "s15_integrated_harness", "code.py")],
];

// def todo_items(module):
function todo_items(module: any): any {
  if ("TODO" in module) {
    return module.TODO.items;
  }
  return module.CURRENT_TODOS;
}

// def load_course_module(module_name: str, module_path: Path, temp_cwd: Path):
function load_course_module(
  module_name: string,
  module_path: string,
  temp_cwd: string
): any {
  const fake_anthropic: any = types.ModuleType("anthropic");

  class FakeAnthropic {
    messages: any;
    constructor(...args: any[]) {
      this.messages = types.SimpleNamespace({ create: null });
    }
  }

  const fake_dotenv: any = types.ModuleType("dotenv");
  const fake_yaml: any = types.ModuleType("yaml");
  fake_anthropic.Anthropic = FakeAnthropic;
  fake_dotenv.load_dotenv = (override: boolean = true): void => {};
  fake_yaml.safe_load = (text: string): Record<string, any> => ({});
  fake_yaml.YAMLError = Error;

  const previous_modules: Record<string, any> = {
    anthropic: sys.modules["anthropic"],
    dotenv: sys.modules["dotenv"],
    yaml: sys.modules["yaml"],
  };
  const previous_cwd: string = process.cwd();
  const previous_model_id: string | undefined = process.env["MODEL_ID"];

  const spec: any = importlib_util.spec_from_file_location(
    `${module_name}_todo_test`,
    module_path
  );
  if (spec === null || spec.loader === null) {
    throw new Error(`Unable to load ${module_path}`);
  }
  const module: any = importlib_util.module_from_spec(spec);

  sys.modules["anthropic"] = fake_anthropic;
  sys.modules["dotenv"] = fake_dotenv;
  sys.modules["yaml"] = fake_yaml;
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

// class TodoWriteStringInputTests(unittest.TestCase):
describe("TodoWriteStringInputTests", () => {
  // def test_issue_340_accepts_json_array_string(self):
  test("test_issue_340_accepts_json_array_string", (): void => {
    for (const [module_name, module_path] of COURSE_MODULES) {
      // with self.subTest(module=module_name), tempfile.TemporaryDirectory() as tmp:
      tempfile.TemporaryDirectory((tmp: string): void => {
        const module: any = load_course_module(module_name, module_path, tmp);

        const result: string = module.run_todo_write(
          '[{"content": "inspect repo", "status": "pending"}]'
        );

        expect(
          result.includes("Updated 1") || result.includes("[ ] inspect repo")
        ).toBe(true);
        expect(todo_items(module)).toEqual([
          { content: "inspect repo", status: "pending" },
        ]);
      });
    }
  });

  // def test_issue_340_accepts_python_list_repr_string(self):
  test("test_issue_340_accepts_python_list_repr_string", (): void => {
    for (const [module_name, module_path] of COURSE_MODULES) {
      tempfile.TemporaryDirectory((tmp: string): void => {
        const module: any = load_course_module(module_name, module_path, tmp);

        const result: string = module.run_todo_write(
          "[{'content': 'write tests', 'status': 'in_progress'}]"
        );

        expect(
          result.includes("Updated 1") || result.includes("[>] write tests")
        ).toBe(true);
        expect(todo_items(module)).toEqual([
          { content: "write tests", status: "in_progress" },
        ]);
      });
    }
  });

  // def test_issue_340_does_not_eval_string_inputs(self):
  test("test_issue_340_does_not_eval_string_inputs", (): void => {
    for (const [module_name, module_path] of COURSE_MODULES) {
      tempfile.TemporaryDirectory((tmp: string): void => {
        const tmp_path: string = tmp;
        const marker: string = path.join(tmp_path, "eval_was_executed");
        const module: any = load_course_module(module_name, module_path, tmp_path);

        // f"__import__('pathlib').Path({str(marker)!r}).write_text('bad')"
        const result: string = module.run_todo_write(
          `__import__('pathlib').Path(${JSON.stringify(String(marker))}).write_text('bad')`
        );

        expect(result).toContain("Error:");
        expect(require("fs").existsSync(marker)).toBe(false);
      });
    }
  });
});

// class S05TodoManagerTests(unittest.TestCase):
describe("S05TodoManagerTests", () => {
  // def load_s05(self, temp_cwd: Path):
  function load_s05(temp_cwd: string): any {
    return load_course_module("s05", COURSE_MODULES[0][1], temp_cwd);
  }

  // def test_returns_rendered_progress(self):
  test("test_returns_rendered_progress", (): void => {
    tempfile.TemporaryDirectory((tmp: string): void => {
      const module: any = load_s05(tmp);

      const result: string = module.run_todo_write([
        { content: "inspect repo", status: "completed" },
        { content: "write tests", status: "in_progress" },
      ]);

      expect(result).toContain("[x] inspect repo");
      expect(result).toContain("[>] write tests");
      expect(result).toContain("(1/2 completed)");
    });
  });

  // def test_rejects_invalid_updates_without_replacing_state(self):
  test("test_rejects_invalid_updates_without_replacing_state", (): void => {
    tempfile.TemporaryDirectory((tmp: string): void => {
      const module: any = load_s05(tmp);
      module.run_todo_write([{ content: "keep this", status: "pending" }]);

      const invalid_updates: any[][] = [
        [{ content: "", status: "pending" }],
        [
          { content: "first", status: "in_progress" },
          { content: "second", status: "in_progress" },
        ],
        // [{"content": f"task {index}", "status": "pending"} for index in range(21)]
        Array.from({ length: 21 }, (_, index) => ({
          content: `task ${index}`,
          status: "pending",
        })),
      ];
      for (const update of invalid_updates) {
        // with self.subTest(update=update):
        const result: string = module.run_todo_write(update);
        expect(result).toContain("Error:");
        expect(module.TODO.items).toEqual([
          { content: "keep this", status: "pending" },
        ]);
      }
    });
  });

  // def test_appends_one_reminder_to_the_third_tool_result_batch(self):
  test("test_appends_one_reminder_to_the_third_tool_result_batch", (): void => {
    tempfile.TemporaryDirectory((tmp: string): void => {
      const module: any = load_s05(tmp);
      const responses: any[] = Array.from({ length: 3 }, (_, index) =>
        types.SimpleNamespace({
          stop_reason: "tool_use",
          content: [
            types.SimpleNamespace({
              type: "tool_use",
              id: `tool_${index}`,
              name: "glob",
              input: { pattern: "*.py" },
            }),
          ],
        })
      );
      responses.push(
        types.SimpleNamespace({ stop_reason: "end_turn", content: [] })
      );
      module.client.messages.create = (kwargs: any): any => responses.shift();

      const messages: any[] = [];
      module.agent_loop(messages);

      const result_batches: any[] = messages
        .filter(
          (message: any) =>
            message["role"] === "user" && Array.isArray(message["content"])
        )
        .map((message: any) => message["content"]);
      expect(result_batches.length).toBe(3);
      expect(
        result_batches[0].some((item: any) => item["type"] === "text")
      ).toBe(false);
      expect(
        result_batches[1].some((item: any) => item["type"] === "text")
      ).toBe(false);
      expect(
        result_batches[2].filter((item: any) => item["type"] === "text")
      ).toEqual([
        { type: "text", text: "<reminder>Update your todos.</reminder>" },
      ]);
    });
  });
});

// if __name__ == "__main__": unittest.main()
