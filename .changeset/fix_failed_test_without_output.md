---
default: patch
---

# Fixed a failed test without output aborting the report

A failed test with no captured output stopped processing of the remaining failures, the stdout group, coverage, and the summary line.
