---
default: patch
---

# Resolve each package directory once

`go list` is now run once per package rather than once per annotation.
