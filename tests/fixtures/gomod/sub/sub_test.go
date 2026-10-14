package sub

import "testing"

func TestParent(t *testing.T) {
	t.Run("ok", func(t *testing.T) {})
	t.Run("bad", func(t *testing.T) {
		t.Errorf("sub failed")
	})
}
