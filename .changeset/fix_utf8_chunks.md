---
default: patch
---

# Fixed corrupted multi-byte characters in test output

Output is now decoded with a streaming UTF-8 decoder, so characters split across stdout chunks are no longer mangled.
