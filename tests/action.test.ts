import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

const root = path.resolve(import.meta.dir, ".."),
  entry = path.join(root, "dist", "index.js"),
  fixture = path.join(root, "tests", "fixtures", "gomod");

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function runAction(inputs: Record<string, string>, extraEnv: Record<string, string> = {}): Result {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GITHUB_WORKSPACE: fixture,
    "INPUT_SHOW-PASSED-TESTS": "true",
    "INPUT_SHOW-CODE-COVERAGE": "true",
    "INPUT_SHOW-LONG-RUNNING-TESTS": "30",
    "INPUT_WORKING-DIRECTORY": fixture,
    INPUT_ARGS: "",
    ...extraEnv,
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
  beforeAll(() => {
    // warm the go build cache so the first test run does not pay for compiling std
    const res = spawnSync("go", ["vet", "./pass/..."], { cwd: fixture, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`go vet failed: ${res.stderr}`);
  });

  test("dist bundle exists", () => {
    expect(existsSync(entry)).toBe(true);
  });

  test("passing package succeeds", () => {
    const res = runAction({ package: "./pass/..." });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("example.com/fixture/pass/TestAdd passed in");
    expect(res.stdout).not.toContain("example.com/fixture/pass passed in");
    expect(res.stdout).toContain("1/1 tests passed");
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
    expect(res.stdout).toContain("1/1 tests passed");
  });

  test("failing test annotates the file and line", () => {
    const res = runAction({ package: "./fail/..." });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("::error::1/2 tests failed");
    expect(res.stdout).toContain("1/2 tests passed");
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
    expect(res.stdout).toContain("1/1 tests panicked");
    expect(res.stdout).toContain("index out of range");
  });

  test("args are split on semicolons", () => {
    const res = runAction({ package: "./pass/...", args: "-run;TestNothing" });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Running test as "go test -json -v -run TestNothing ./pass/..."');
    expect(res.stdout).toContain("0/0 tests passed");
  });

  test("package setup failures fail the action", () => {
    const res = runAction({ package: "./does/not/exist" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("::error::1 package(s) failed");
    expect(res.stdout).toContain("[setup failed]");
  });
});

describe("go output edge cases", () => {
  test("compiler errors are annotated", () => {
    const res = runAction({ package: "./build/..." });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("1 package(s) failed to build");
    const errs = annotations(res.stdout);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("file=build/build.go");
    expect(errs[0]).toContain("line=3");
    expect(errs[0]).toContain("undefined: undefinedThing");
    expect(res.stdout).not.toContain("tests failed");
  });

  test("plain panics are annotated at the deepest workspace frame", () => {
    const res = runAction({ package: "./boom/..." });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("1/1 tests panicked");
    const errs = annotations(res.stdout);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("title=Test example.com/fixture/boom/TestBoom panicked");
    expect(errs[0]).toContain("file=boom/boom.go");
    expect(errs[0]).toContain("line=4");
    expect(res.stdout).toContain("0/1 tests passed");
  });

  test("runtime panics are annotated", () => {
    const res = runAction({ package: "./panics/..." });
    const errs = annotations(res.stdout);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("file=panics/panics.go");
    expect(errs[0]).toContain("line=3");
  });

  test("timed out tests are reported", () => {
    const res = runAction({ package: "./timeout/...", args: "-timeout;1s" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("1/1 tests timed out");
    const errs = annotations(res.stdout);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("title=Test example.com/fixture/timeout/TestSlow timed out");
    expect(errs[0]).toContain("file=timeout/timeout_test.go");
    expect(errs[0]).toContain("line=9");
  });

  test("subtest failures count once", () => {
    const res = runAction({ package: "./sub/..." });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("::error::1/2 tests failed");
    expect(res.stdout).toContain("1/2 tests passed");
    expect(res.stdout).not.toContain("TestParent failed in");
    const errs = annotations(res.stdout);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("file=sub/sub_test.go");
    expect(errs[0]).toContain("line=8");
  });

  test("upper-case file names are annotated", () => {
    const res = runAction({ package: "./upper/..." });
    const errs = annotations(res.stdout);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("file=upper/MyFile_test.go");
    expect(errs[0]).toContain("line=6");
  });

  test("skipped tests are counted", () => {
    const res = runAction({ package: "./skip/..." });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("example.com/fixture/skip/TestSkipped skipped");
    expect(res.stdout).toContain("1/2 tests passed, 1 skipped");
  });

  test("coverage colors by threshold", () => {
    const res = runAction({ package: "./pass/...", args: "-cover" });
    // 50% is yellow
    expect(res.stdout).toMatch(/pass coverage: \u001b\[33m50%/);
  });

  test("job summary is written", () => {
    const file = path.join(root, "tests", "summary.md");
    if (existsSync(file)) unlinkSync(file);
    writeFileSync(file, "");
    const res = runAction({ package: "./sub/..." }, { GITHUB_STEP_SUMMARY: file });
    expect(res.code).toBe(1);
    const summary = readFileSync(file, "utf8");
    unlinkSync(file);
    expect(summary).toContain("Go Test Results");
    expect(summary).toContain("example.com/fixture/sub/TestParent/bad");
  });
});
