## 2.3.0 (2026-10-14)

### Features

#### Accurate test counts

Package results and parents of subtests are no longer counted as tests, so one failing subtest reports as one failure. Skipped tests are counted and shown in the summary. Package failures without a failing test, such as a panic in `TestMain`, are reported separately.

#### Annotate compiler errors

Packages that fail to build now produce a file and line annotation for each compiler diagnostic instead of only appearing in the raw stdout group.

#### Detect all panics and test timeouts

Any `panic:` in a test's output is now reported as a panic, not just runtime errors. The annotation points at the deepest frame of the goroutine trace inside the workspace. Tests still running when `go test` times out are reported as timed out with the location of the stuck goroutine.

#### Job summary

A results table with the failed tests and build failures is written to the GitHub job summary.

#### Run on Node 24

The action now runs on the `node24` runtime.

### Fixes

#### Resolve each package directory once

`go list` is now run once per package rather than once per annotation.

#### Fixed annotations for Go files with upper-case names

File references like `MyFile_test.go:5` were truncated to `ile_test.go`, pointing annotations at a file that does not exist.

#### Fixed inverted code coverage colors

Coverage above 60% is now green and 30% to 60% is yellow.

#### Fixed a failed test without output aborting the report

A failed test with no captured output stopped processing of the remaining failures, the stdout group, coverage, and the summary line.

#### Fixed corrupted multi-byte characters in test output

Output is now decoded with a streaming UTF-8 decoder, so characters split across stdout chunks are no longer mangled.
