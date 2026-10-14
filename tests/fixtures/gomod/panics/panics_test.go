package panics

import "testing"

func TestIndex(t *testing.T) {
	_ = Index(nil, 3)
}
