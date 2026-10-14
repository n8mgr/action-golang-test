import { exec } from "@actions/exec";
import * as core from "@actions/core";
import { env } from "process";
import path from "path";
import { StringDecoder } from "string_decoder";
import { atoiOrDefault, parseFloatOrDefault } from "./utils";

interface TestAnnotation {
  file: string;
  line: number;
  text: string;
}
interface Test {
  package: string;
  test?: string;
  status?: "pass" | "fail" | "skip";
  elapsed: number;
  output: string[];
}
interface BuildFailure {
  importPath: string;
  output: string[];
}

type Nullable<T> = T | null;

const optShowPassedTests = core.getBooleanInput("show-passed-tests"),
  optShowCodeCoverage = core.getBooleanInput("show-code-coverage"),
  optLongRunningTestDuration = atoiOrDefault(
    core.getInput("show-long-running-tests"),
    15,
  ),
  optWorkingDir = core.getInput("working-directory");

const testOutput: Map<string, Test> = new Map<string, Test>(),
  buildFailures: Map<string, BuildFailure> = new Map<string, BuildFailure>(),
  parents: Set<string> = new Set<string>(),
  panicked: Set<string> = new Set<string>(),
  timedOut: Set<string> = new Set<string>(),
  errored: Set<string> = new Set<string>(),
  failedPackages: Set<string> = new Set<string>(),
  codeCoverage: Map<string, number> = new Map<string, number>(),
  packageDirs: Map<string, Promise<string>> = new Map<string, Promise<string>>();
let errout: string = "",
  stdout: string = "",
  processedStdout: string = "";

// go file references in test log output, e.g. "    my_test.go:12: message"
const goFileRegex = /([\w.-]+\.go):(\d+)/,
  // compiler diagnostics, e.g. "pkg/file.go:3:23: undefined: x"
  buildErrorRegex = /^([\w./-]+\.go):(\d+)(?::\d+)?: /,
  // goroutine trace frames, e.g. "\t/abs/path/file.go:12 +0x2c"
  traceFrameRegex = /^\t(\/\S+\.go):(\d+)/,
  // tests listed under "panic: test timed out", e.g. "\t\tTestSlow (1s)"
  runningTestRegex = /^\t\t(\S+) \(/,
  newLineReg = new RegExp(/\r?\n/);

const stdoutDecoder = new StringDecoder("utf8"),
  stderrDecoder = new StringDecoder("utf8");
let buf: string = "",
  collectingTimedOut: Nullable<string> = null;

function parseStdout(data: Uint8Array) {
  if (!data) return;

  let result: RegExpExecArray | null;
  const text = stdoutDecoder.write(Buffer.from(data));
  stdout += text;
  buf += text;
  while ((result = newLineReg.exec(buf)) !== null) {
    const line = buf.slice(0, result.index);
    buf = buf.slice(result.index + result[0].length);
    processOutput(line);
  }
}

function parseStdErr(data: Uint8Array) {
  if (!data) return;

  errout += stderrDecoder.write(Buffer.from(data));
}

function workspaceRoot(): string {
  return env["GITHUB_WORKSPACE"] || process.cwd();
}

// converts an absolute path to a path relative to the workspace so it can be
// used in annotations. Returns null for files outside the workspace, e.g. the
// Go standard library or the module cache.
function workspaceRelative(full: string): Nullable<string> {
  const root = workspaceRoot();
  if (full === root) return null;
  if (full.startsWith(root + path.sep)) return full.slice(root.length + 1);
  return null;
}

function getPackageDir(goPkg: string): Promise<string> {
  let dir = packageDirs.get(goPkg);
  if (dir) return dir;

  dir = (async () => {
    core.debug(`getting package path for ${goPkg}...`);
    let packagePath = "",
      errorMsg = "";
    const exitCode = await exec("go", ["list", "-f", "{{.Dir}}", goPkg], {
      cwd: optWorkingDir ? optWorkingDir : undefined,
      silent: true,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Uint8Array) => {
          packagePath += data.toString();
        },
        stderr: (data: Uint8Array) => {
          errorMsg += data.toString();
        },
      },
    });

    packagePath = packagePath.trim();
    errorMsg = errorMsg.trim();

    if (exitCode !== 0)
      throw new Error(`failed to get package path for ${goPkg}: ${errorMsg}`);
    else if (packagePath === "")
      throw new Error(`failed to get package path for ${goPkg} (empty output)`);
    core.debug(`package path for ${goPkg} is ${packagePath}`);
    return packagePath;
  })();
  packageDirs.set(goPkg, dir);
  return dir;
}

async function getRelativeFilePath(
  goPkg: string,
  file: string,
): Promise<string> {
  const full = path.join(await getPackageDir(goPkg), file);
  core.debug(`absolute path for ${goPkg}/${file} is ${full}`);
  const rel = workspaceRelative(full);
  if (rel !== null) return rel;
  // outside the workspace, fall back to the previous behaviour of stripping
  // the leading slash so the annotation still carries the path
  return full.startsWith("/") ? full.slice(1) : full;
}

// resolves a path printed relative to the go test working directory
function workingDirRelativeFilePath(file: string): string {
  const full = path.resolve(optWorkingDir || ".", file),
    rel = workspaceRelative(full);
  if (rel !== null) return rel;
  return full.startsWith("/") ? full.slice(1) : full;
}

function processBuildEvent(parsed: any) {
  // ImportPath looks like "pkg [pkg.test]" for test binaries
  const importPath = (parsed.ImportPath as string).replace(/ \[.*\]$/, "");
  let failure = buildFailures.get(importPath);
  if (!failure) {
    failure = { importPath, output: [] };
    buildFailures.set(importPath, failure);
  }
  if (parsed.Action === "build-output" && parsed.Output) {
    processedStdout += parsed.Output;
    failure.output.push(parsed.Output);
  }
}

function processOutput(line: string) {
  try {
    const parsed = JSON.parse(line);
    if (parsed.Action === "build-output" || parsed.Action === "build-fail") {
      processBuildEvent(parsed);
      return;
    }
    if (!parsed.Package) return;

    const key = `${parsed.Package}${parsed.Test ? "/" + parsed.Test : ""}`;
    let results = testOutput.get(key);

    if (!results)
      results = {
        package: parsed.Package,
        test: parsed.Test,
        elapsed: 0,
        output: [],
      };

    if (parsed.Test) {
      const sep = parsed.Test.lastIndexOf("/");
      if (sep !== -1)
        parents.add(`${parsed.Package}/${parsed.Test.slice(0, sep)}`);
    }

    if (parsed.Output) {
      processedStdout += parsed.Output;
    }

    switch (parsed.Action) {
      case "output":
        // parse panics or errors
        if (parsed.Output.startsWith("panic: test timed out")) {
          collectingTimedOut = parsed.Package;
        } else if (collectingTimedOut === parsed.Package) {
          const running = parsed.Output.match(runningTestRegex);
          if (running) timedOut.add(`${parsed.Package}/${running[1]}`);
          else if (!parsed.Output.startsWith("\trunning tests:"))
            collectingTimedOut = null;
        } else if (parsed.Output.startsWith("panic:")) {
          if (parsed.Test) panicked.add(key);
        } else if (parsed.Output.indexOf("==ERROR:") !== -1) errored.add(key);

        // parse code coverage
        const coverageReg = new RegExp(/^coverage: (\d+\.\d+)% of statements/),
          match = parsed.Output.match(coverageReg);
        if (match) codeCoverage.set(parsed.Package, parseFloat(match[1]));
        else if (
          parsed.Output.indexOf("[no test files]") !== -1 &&
          !codeCoverage.has(parsed.Package)
        )
          codeCoverage.set(parsed.Package, 0);

        results.output.push(parsed.Output);
        break;
      case "fail":
        results.elapsed = parseFloatOrDefault(parsed.Elapsed);
        results.status = "fail";
        if (!parsed.Test) {
          failedPackages.add(parsed.Package);
          break;
        }
        if (parents.has(key)) break; // reported through the failing subtest

        if (
          optLongRunningTestDuration !== -1 &&
          results.elapsed >= optLongRunningTestDuration
        )
          core.info(`\u001b[33m${key} took ${results.elapsed}s to fail`);

        core.info(`\u001b[31m${key} failed in ${results.elapsed}s`);
        break;
      case "pass":
        results.elapsed = parseFloatOrDefault(parsed.Elapsed);
        results.status = "pass";
        if (!parsed.Test || parents.has(key)) break;

        if (
          optLongRunningTestDuration !== -1 &&
          results.elapsed >= optLongRunningTestDuration
        )
          core.info(`\u001b[33m${key} passed in ${results.elapsed}s`);
        else if (optShowPassedTests)
          core.info(`\u001b[32m${key} passed in ${results.elapsed}s`);
        break;
      case "skip":
        results.elapsed = parseFloatOrDefault(parsed.Elapsed);
        results.status = "skip";
        if (parsed.Test && !parents.has(key) && optShowPassedTests)
          core.info(`\u001b[33m${key} skipped`);
        break;
    }

    testOutput.set(key, results);
  } catch (ex) {
    core.error(`failed to process line "${line}": ${ex}`);
  }
}

function processAnnotations(output: string[]): TestAnnotation[] {
  const annotations: TestAnnotation[] = [];
  let current: Nullable<TestAnnotation> = null;
  for (const line of output) {
    const normalized = line.trim();
    if (normalized.startsWith("=== RUN") || normalized.startsWith("--- FAIL"))
      // ignore go test output
      continue;
    else if (line.startsWith("panic:")) {
      // panics must be handled separately
      break;
    }
    const match = normalized.match(goFileRegex);
    if (match) {
      // if the output matches, create a new annotation
      if (current) annotations.push(current); // push the current annotation

      current = {
        file: match[1],
        line: parseInt(match[2]),
        text: line,
      };
      continue;
    }

    // append the line to the current annotation
    if (current) current.text += line;
  }

  // push the last annotation
  if (current) annotations.push(current);
  return annotations.map((a) => ({ ...a, text: a.text.trim() }));
}

// finds the first goroutine trace frame inside the workspace, which is the
// deepest frame of the user's own code
function traceLocation(
  output: string[],
  after?: RegExp,
): Nullable<{ file: string; line: number }> {
  let started = !after;
  for (const line of output) {
    if (!started) {
      started = !!after && after.test(line);
      continue;
    }
    const match = line.match(traceFrameRegex);
    if (!match) continue;
    const rel = workspaceRelative(match[1]);
    if (rel !== null) return { file: rel, line: parseInt(match[2]) };
  }
  return null;
}

function reportCrashed(
  verb: string,
  keys: Iterable<string>,
  traceOutput?: (results: Test) => string[],
) {
  for (const k of keys) {
    const results = testOutput.get(k);
    if (!results || !results?.output?.length) continue;

    core.startGroup(`Test ${k} output`);
    const trace = traceOutput ? traceOutput(results) : results.output,
      loc = traceLocation(
        trace,
        traceOutput && results.test
          ? new RegExp(
              `^${results.package.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")}\\.${results.test.split("/")[0]}[.(]`,
            )
          : undefined,
      ),
      text =
        `Test ${k} ${verb} in ${results.elapsed}s:\n` + results.output.join("");
    if (loc)
      core.error(text, {
        title: `Test ${k} ${verb}`,
        file: loc.file,
        startLine: loc.line,
      });
    else core.error(text);
    core.endGroup();
  }
}

function writeSummary(
  passed: number,
  failed: string[],
  skipped: number,
  total: number,
  elapsed: number,
) {
  if (!env["GITHUB_STEP_SUMMARY"]) return Promise.resolve();
  const summary = core.summary
    .addHeading("Go Test Results", 2)
    .addTable([
      [
        { data: "Passed", header: true },
        { data: "Failed", header: true },
        { data: "Skipped", header: true },
        { data: "Total", header: true },
        { data: "Elapsed", header: true },
      ],
      [
        `${passed}`,
        `${failed.length}`,
        `${skipped}`,
        `${total}`,
        `${elapsed.toFixed(2)}s`,
      ],
    ]);
  if (failed.length) summary.addHeading("Failed", 3).addList(failed);
  if (buildFailures.size)
    summary
      .addHeading("Build failures", 3)
      .addList([...buildFailures.keys()]);
  return summary.write();
}

export async function runTests() {
  const args = ["test", "-json", "-v"].concat(
      (core.getInput("args") || "")
        .split(";")
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
    ),
    start = Date.now();

  args.push(core.getInput("package"));
  core.info(`Running test as "go ${args.join(" ")}"`);

  const exit = await exec("go", args, {
    cwd: optWorkingDir ? optWorkingDir : undefined,
    ignoreReturnCode: true,
    silent: !core.isDebug(),
    listeners: {
      // cannot use stdline or errline because Go's CLI tools do not behave.
      stdout: parseStdout,
      stderr: parseStdErr,
    },
  });

  buf += stdoutDecoder.end();
  errout += stderrDecoder.end();
  if (buf.length !== 0) processOutput(buf);

  // leaf tests only: a parent of subtests is reported through its children
  const tests = [...testOutput.values()].filter(
      (t) => t.test && !parents.has(`${t.package}/${t.test}`),
    ),
    keyOf = (t: Test) => `${t.package}/${t.test}`,
    failed = tests
      .filter((t) => {
        const k = keyOf(t);
        return (
          t.status === "fail" ||
          panicked.has(k) ||
          timedOut.has(k) ||
          errored.has(k)
        );
      })
      .map(keyOf),
    skipped = tests.filter((t) => t.status === "skip").length,
    totalRun = tests.length,
    passed = totalRun - failed.length - skipped,
    // package failures not explained by a failing test, e.g. a panic in
    // TestMain, os.Exit, or a failed package setup
    unexplainedPackages = [...failedPackages].filter(
      (pkg) =>
        !buildFailures.has(pkg) &&
        !failed.some((k) => k.startsWith(pkg + "/")),
    );

  // If go test returns a non-zero exit code with no failed tests, something
  // went wrong.
  if (
    exit !== 0 &&
    failed.length === 0 &&
    buildFailures.size === 0 &&
    unexplainedPackages.length === 0
  ) {
    core.setFailed(
      `go test failed with exit code ${exit}, but no tests failed. Check output for more details`,
    );
  }

  // print any build failures
  if (buildFailures.size > 0) {
    core.setFailed(`${buildFailures.size} package(s) failed to build`);
    for (const failure of buildFailures.values()) {
      core.startGroup(`Build ${failure.importPath} output`);
      for (const line of failure.output) {
        const match = line.match(buildErrorRegex);
        if (!match) continue;
        core.error(line.trim(), {
          title: `Build ${failure.importPath} failed`,
          file: workingDirRelativeFilePath(match[1]),
          startLine: parseInt(match[2]),
        });
      }
      core.info(failure.output.join(""));
      core.endGroup();
    }
  }

  // print any panicked tests
  if (panicked.size > 0) {
    core.setFailed(`${panicked.size}/${totalRun} tests panicked`);
    reportCrashed("panicked", panicked);
  }

  // print any timed out tests, the trace is attached to the package
  if (timedOut.size > 0) {
    core.setFailed(`${timedOut.size}/${totalRun} tests timed out`);
    // the trace is attributed to the running test or to the package depending on the go version
    reportCrashed("timed out", timedOut, (results) =>
      results.output.concat(testOutput.get(results.package)?.output || []),
    );
  }

  // print any errored tests, includes tests with build errors
  if (errored.size > 0) {
    core.setFailed(`${errored.size}/${totalRun} tests errored`);
    errored.forEach((k) => {
      const results = testOutput.get(k);

      if (!results || !results?.output?.length) return;

      core.startGroup(`Test ${k} output`);
      core.error(
        `Test ${k} errored in ${results.elapsed}s:\n` + results.output.join(""),
      );
      core.endGroup();
    });
  }

  // print any failed tests
  const plainFailed = failed.filter(
    (k) => !panicked.has(k) && !timedOut.has(k) && !errored.has(k),
  );
  if (failed.length > 0)
    core.setFailed(`${failed.length}/${totalRun} tests failed`);
  for (const k of plainFailed) {
    const results = testOutput.get(k);

    if (!results || !results?.output?.length) continue;

    core.startGroup(`Test ${k} output`);
    // add file annotations
    const annotations = processAnnotations(results.output);
    for (const a of annotations) {
      try {
        core.error(a.text, {
          title: `Test ${k} failed in ${results.elapsed}s`,
          file: await getRelativeFilePath(results.package, a.file),
          startLine: a.line,
        });
      } catch (ex) {
        core.error(`Failed to get relative file path for ${a.file}: ${ex}`);
        continue;
      }
    }
    // log the raw output
    core.info(results.output.join(""));
    core.endGroup();
  }

  // print any package failures without a failing test
  if (unexplainedPackages.length > 0) {
    core.setFailed(`${unexplainedPackages.length} package(s) failed`);
    for (const pkg of unexplainedPackages) {
      const results = testOutput.get(pkg);
      core.startGroup(`Package ${pkg} output`);
      core.error(
        `Package ${pkg} failed:\n` + (results?.output || []).join(""),
      );
      core.endGroup();
    }
  }

  if (processedStdout) {
    core.startGroup("stdout");
    core.info(processedStdout);
    core.endGroup();
  }

  // if something was written to stderr, print it
  // note: this can include Go package downloads, it's not always an error
  if (errout.length > 0) {
    core.startGroup("stderr");
    core.info(errout);
    core.endGroup();
  }

  if (optShowCodeCoverage) {
    core.startGroup("Code Coverage");
    for (const [pkg, coverage] of codeCoverage) {
      const colorCode =
          coverage < 30
            ? "\u001b[31m"
            : coverage < 60
              ? "\u001b[33m"
              : "\u001b[32m",
        msg = `${pkg} coverage: ${colorCode}${coverage}%\u001b[0m of statements`;

      core.info(msg);
    }
    core.endGroup();
  }

  const totalElapsed = (Date.now() - start) / 1000;
  core.info(
    `\u001b[32m${passed}/${totalRun} tests passed${skipped ? `, ${skipped} skipped` : ""} in ${totalElapsed.toFixed(2)}s`,
  );
  await writeSummary(passed, failed, skipped, totalRun, totalElapsed);
}
