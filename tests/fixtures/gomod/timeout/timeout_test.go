package timeout

import (
	"testing"
	"time"
)

func TestSlow(t *testing.T) {
	time.Sleep(5 * time.Second)
}
