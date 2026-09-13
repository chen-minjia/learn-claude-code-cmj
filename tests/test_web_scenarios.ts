// from __future__ import annotations
// (TS 无需此声明,仅作对照保留)

// import asyncio —— TS 使用 async/await 与 Promise 表达
import * as importlib_util from "importlib/util"; // Python: import importlib.util
import * as fs from "fs"; // 读取 JSON 文件
import * as re from "re"; // Python: import re —— 使用 RegExp 表达
import * as path from "path"; // Python: from pathlib import Path

// ROOT = Path(__file__).resolve().parents[1]
const ROOT: string = path.resolve(__dirname, "..");
// SCENARIOS = ROOT / "web" / "src" / "data" / "scenarios"
const SCENARIOS: string = path.join(ROOT, "web", "src", "data", "scenarios");
// GENERATED_VERSIONS = ROOT / "web" / "src" / "data" / "generated" / "versions.json"
const GENERATED_VERSIONS: string = path.join(
  ROOT,
  "web",
  "src",
  "data",
  "generated",
  "versions.json"
);

// def load_scenario(lesson: str) -> dict:
function load_scenario(lesson: string): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(path.join(SCENARIOS, `${lesson}.json`), "utf-8")
  );
}

// def load_lesson(name: str, script: Path):
function load_lesson(name: string, script: string): any {
  const spec: any = importlib_util.spec_from_file_location(name, script);
  if (spec === null || spec.loader === null) {
    throw new Error(`unable to load ${script}`);
  }
  const module: any = importlib_util.module_from_spec(spec);
  spec.loader.exec_module(module);
  return module;
}

// def test_s13_scenario_uses_the_real_plan_protocol() -> None:
test("test_s13_scenario_uses_the_real_plan_protocol", (): void => {
  const steps: any[] = load_scenario("s13")["steps"];
  const spawn: any = steps.find(
    (step: any) =>
      step["toolName"] === "spawn_teammate" &&
      (step["content"] ?? "").includes('"name":"backend"')
  );
  const claim_index: number = steps.findIndex((step: any) =>
    (step["content"] ?? "").includes("spawn_teammate(backend")
  );
  const request_index: number = steps.findIndex(
    (step: any) => step["toolName"] === "request_plan"
  );
  const review_index: number = steps.findIndex(
    (step: any) => step["toolName"] === "review_plan"
  );
  const response_index: number = steps.findIndex((step: any) =>
    (step["content"] ?? "").includes("plan_approval_response")
  );

  const review: any = JSON.parse(steps[review_index]["content"]);
  const spawn_input: any = JSON.parse(spawn["content"]);
  expect(spawn_input["require_plan"]).toBe(true);
  // re.fullmatch(r"task_[0-9a-f]{8}", spawn_input["task_id"])
  expect(re.fullmatch(/task_[0-9a-f]{8}/, spawn_input["task_id"])).toBeTruthy();
  expect(
    claim_index < request_index &&
      request_index < review_index &&
      review_index < response_index
  ).toBe(true);
  expect(review["request_id"]).toBe("req_000007");
  expect(re.fullmatch(/req_\d{6}/, review["request_id"])).toBeTruthy();
  expect(review["approve"]).toBe(true);
  expect("approved" in review).toBe(false);
});

// def test_s15_scenario_calls_the_discovered_mcp_tool() -> None:
test("test_s15_scenario_calls_the_discovered_mcp_tool", (): void => {
  const steps: any[] = load_scenario("s15")["steps"];
  const bash_index: number = steps.findIndex(
    (step: any) => step["toolName"] === "bash"
  );
  const approval_index: number = steps.findIndex((step: any) =>
    (step["content"] ?? "").includes("permission: user approved")
  );
  const connect_index: number = steps.findIndex(
    (step: any) => step["toolName"] === "connect_mcp"
  );
  const status_index: number = steps.findIndex(
    (step: any) =>
      step["toolName"] === "mcp__deploy__status" &&
      step["type"] === "tool_call"
  );
  const result_index: number = steps.findIndex(
    (step: any) =>
      step["toolName"] === "mcp__deploy__status" &&
      step["type"] === "tool_result"
  );
  const notification_index: number = steps.findIndex((step: any) =>
    (step["content"] ?? "").includes("task_notification(status=completed)")
  );

  const bash_call: any = JSON.parse(steps[bash_index]["content"]);
  expect(bash_call).toEqual({
    command: "python -m unittest tests.test_agent_teams_runtime",
    run_in_background: true,
  });
  expect(bash_index < approval_index && approval_index < notification_index).toBe(
    true
  );
  expect(connect_index < status_index && status_index < result_index).toBe(true);
});

// def test_s15_runtime_discovers_and_dispatches_mcp_tools(tmp_path, monkeypatch) -> None:
test("test_s15_runtime_discovers_and_dispatches_mcp_tools", (): void => {
  const tmp_path: string = makeTmpPath();
  // monkeypatch.setenv("MODEL_ID", "test-model")
  process.env["MODEL_ID"] = "test-model";
  const harness: any = load_lesson(
    "integrated_mcp_scenario_test",
    path.join(ROOT, "s15_integrated_harness", "code.py")
  );
  harness.WORKDIR = tmp_path;

  // _, handlers_before = harness.assemble_tool_pool()
  const [, handlers_before] = harness.assemble_tool_pool();
  expect("mcp__deploy__status" in handlers_before).toBe(false);
  expect(harness.connect_mcp("deploy")).toContain(
    "Connected to MCP server 'deploy'"
  );

  const [tools_after, handlers_after] = harness.assemble_tool_pool();
  expect(new Set(tools_after.map((tool: any) => tool["name"]))).toContain(
    "mcp__deploy__status"
  );
  expect(handlers_after["mcp__deploy__status"]({ service: "web" })).toBe(
    "[deploy] web: running (v1.4.2)"
  );
});

// def test_s16_scenario_matches_the_deterministic_runtime(tmp_path) -> None:
test("test_s16_scenario_matches_the_deterministic_runtime", async (): Promise<void> => {
  const tmp_path: string = makeTmpPath();
  const scenario: any = load_scenario("s16");
  const workflow_call: any = scenario["steps"].find(
    (step: any) =>
      step["toolName"] === "Workflow" && step["type"] === "tool_call"
  );
  const workflow_result: any = scenario["steps"].find(
    (step: any) =>
      step["toolName"] === "Workflow" && step["type"] === "tool_result"
  );
  const call_input: any = JSON.parse(workflow_call["content"]);
  const shown_result: any = JSON.parse(workflow_result["content"]);

  const workflow: any = load_lesson(
    "workflow_scenario_test",
    path.join(ROOT, "s16_workflow_runtime", "code.py")
  );
  workflow.STORE = tmp_path;
  workflow.create_run_id = (_meta: any): string =>
    "wf_review-changes_0000000000001a7b";
  // actual = asyncio.run(workflow.run_workflow(**call_input))
  const actual: any = await workflow.run_workflow(call_input);

  // set(call_input) <= set(workflow.WORKFLOW_TOOL["input_schema"]["properties"])
  const call_input_keys: Set<string> = new Set(Object.keys(call_input));
  const property_keys: Set<string> = new Set(
    Object.keys(workflow.WORKFLOW_TOOL["input_schema"]["properties"])
  );
  expect([...call_input_keys].every((k) => property_keys.has(k))).toBe(true);
  expect(shown_result).toEqual(actual);
});

// def test_generated_s16_metadata_extends_s15_without_registry_false_positives() -> None:
test("test_generated_s16_metadata_extends_s15_without_registry_false_positives", (): void => {
  const versions: any = JSON.parse(fs.readFileSync(GENERATED_VERSIONS, "utf-8"));
  // by_id = {version["id"]: version for version in versions["versions"]}
  const by_id: Record<string, any> = Object.fromEntries(
    versions["versions"].map((version: any) => [version["id"], version])
  );
  const s15: any = by_id["s15"];
  const s16: any = by_id["s16"];

  // set(s15["tools"]) < set(s16["tools"])  (真子集)
  const s15_tools: Set<string> = new Set(s15["tools"]);
  const s16_tools: Set<string> = new Set(s16["tools"]);
  expect(
    [...s15_tools].every((t) => s16_tools.has(t)) &&
      s15_tools.size < s16_tools.size
  ).toBe(true);
  expect(s16["newTools"]).toEqual(["Workflow"]);
  expect(s16_tools.has("Workflow")).toBe(true);
  expect(s16_tools.has("review-changes")).toBe(false);
  // chapter_dirs = {path.name.split("_", 1)[0]: path for path in ROOT.glob("s[0-9][0-9]_*")}
  const chapter_dirs: Record<string, string> = {};
  for (const p of require("glob").sync(path.join(ROOT, "s[0-9][0-9]_*"))) {
    chapter_dirs[path.basename(p).split("_")[0]] = p;
  }
  for (const lesson_id of ["s11", "s12", "s13", "s14", "s15", "s16"]) {
    expect(by_id[lesson_id]["source"]).toBe(
      fs.readFileSync(path.join(chapter_dirs[lesson_id], "code.py"), "utf-8")
    );
  }
  // signatures = {function["name"]: function["signature"] for function in s16["functions"]}
  const signatures: Record<string, string> = Object.fromEntries(
    s16["functions"].map((func: any) => [func["name"], func["signature"]])
  );
  expect(signatures["run_workflow"].startsWith("async def run_workflow(")).toBe(
    true
  );
});

// 对应 pytest 的 tmp_path fixture,返回一个临时目录路径
function makeTmpPath(): string {
  return require("fs").mkdtempSync(
    path.join(require("os").tmpdir(), "pytest-")
  );
}
