package fail

import "testing"

func TestMul(t *testing.T) {
	if Mul(2, 2) != 5 {
		t.Fatalf("expected %d, got %d", 5, Mul(2, 2))
	}
}

func TestMulOK(t *testing.T) {
	if Mul(2, 2) != 4 {
		t.Fatal("expected 4")
	}
}
