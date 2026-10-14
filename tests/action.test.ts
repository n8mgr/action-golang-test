import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

const root = path.resolve(import.meta.dir, ".."),
  entry = path.join(root, "dist", "index.js"),
  fixture = path.join(root, "tests", "fixtures", "gomod");

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function runAction(inputs: Record<string, string>): Result {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GITHUB_WORKSPACE: fixture,
    "INPUT_SHOW-PASSED-TESTS": "true",
    "INPUT_SHOW-CODE-COVERAGE": "true",
    "INPUT_SHOW-LONG-RUNNING-TESTS": "30",
    "INPUT_WORKING-DIRECTORY": fixture,
    INPUT_ARGS: "",
  };
  for (const [k, v] of Object.entries(inputs))
    env[`INPUT_${k.toUpperCase()}`] = v;
  const res = spawnSync("node", [entry], { env, encoding: "utf8" });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

// file annotations are emitted as workflow commands with properties, e.g.
// ::error title=...,file=fail/fail_test.go,line=7::...
// plain ::error::msg lines come from setFailed and are not annotations
function annotations(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((l) => /^::error [^:]*file=/.test(l));
}

describe("action", () => {
  test("dist bundle exists", () => {
    expect(existsSync(entry)).toBe(true);
  });

  test("passing package succeeds", () => {
    const res = runAction({ package: "./pass/..." });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("example.com/fixture/pass/TestAdd passed in");
    expect(res.stdout).toContain("example.com/fixture/pass passed in");
    // package results are counted alongside individual tests
    expect(res.stdout).toContain("2/2 tests passed");
    expect(annotations(res.stdout)).toHaveLength(0);
  });

  test("code coverage is reported", () => {
    const res = runAction({ package: "./pass/...", args: "-cover" });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/example\.com\/fixture\/pass coverage: \u001b\[\d+m50%/);
  });

  test("code coverage can be hidden", () => {
    const res = runAction({ package: "./pass/...", args: "-cover", "show-code-coverage": "false" });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("::group::Code Coverage");
    expect(res.stdout).not.toMatch(/pass coverage: \u001b/);
  });

  test("passed tests can be hidden", () => {
    const res = runAction({ package: "./pass/...", "show-passed-tests": "false" });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("TestAdd passed in");
    expect(res.stdout).not.toContain("fixture/pass passed in");
    expect(res.stdout).toContain("2/2 tests passed");
  });

  test("failing test annotates the file and line", () => {
    const res = runAction({ package: "./fail/..." });
    expect(res.code).toBe(1);
    // TestMul and the package itself fail, TestMulOK passes
    expect(res.stdout).toContain("2/3 tests failed");
    expect(res.stdout).toContain("1/3 tests passed");
    const errs = annotations(res.stdout);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("file=fail/fail_test.go");
    expect(errs[0]).toContain("line=7");
    expect(errs[0]).toContain("title=Test example.com/fixture/fail/TestMul failed in");
    expect(errs[0]).toContain("expected 5, got 4");
  });

  test("panicking test is reported", () => {
    const res = runAction({ package: "./panics/..." });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("tests panicked");
    // panics are reported as plain errors with the full test output, not file annotations
    expect(res.stdout).toContain("::error::Test example.com/fixture/panics/TestIndex panicked in");
    expect(res.stdout).toContain("index out of range");
    expect(annotations(res.stdout)).toHaveLength(0);
  });

  test("args are split on semicolons", () => {
    const res = runAction({ package: "./pass/...", args: "-run;TestNothing" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Running test as "go test -json -v -run TestNothing ./pass/..."');
    expect(res.stdout).toContain("1/1 tests passed");
  });

  test("package setup failures fail the action", () => {
    const res = runAction({ package: "./does/not/exist" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("::error::1/1 tests failed");
    expect(res.stdout).toContain("[setup failed]");
  });
});
