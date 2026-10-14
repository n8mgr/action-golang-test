---
default: patch
---

# Fixed annotations for Go files with upper-case names

File references like `MyFile_test.go:5` were truncated to `ile_test.go`, pointing annotations at a file that does not exist.
