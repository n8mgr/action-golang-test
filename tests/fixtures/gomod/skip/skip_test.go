package skip

import "testing"

func TestSkipped(t *testing.T) {
	t.Skip("not today")
}

func TestRan(t *testing.T) {}
