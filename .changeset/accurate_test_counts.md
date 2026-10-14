---
default: minor
---

# Accurate test counts

Package results and parents of subtests are no longer counted as tests, so one failing subtest reports as one failure. Skipped tests are counted and shown in the summary. Package failures without a failing test, such as a panic in `TestMain`, are reported separately.
