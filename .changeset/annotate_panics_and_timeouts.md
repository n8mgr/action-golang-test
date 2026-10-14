---
default: minor
---

# Detect all panics and test timeouts

Any `panic:` in a test's output is now reported as a panic, not just runtime errors. The annotation points at the deepest frame of the goroutine trace inside the workspace. Tests still running when `go test` times out are reported as timed out with the location of the stuck goroutine.
