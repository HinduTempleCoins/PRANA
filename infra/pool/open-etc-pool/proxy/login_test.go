package proxy

import "testing"

func TestSplitLogin(t *testing.T) {
	cases := []struct{ in, addr, worker string }{
		{"0x444364f45a41512D51a0e942D1F01e8893451F0c", "0x444364f45a41512D51a0e942D1F01e8893451F0c", ""},
		{"0x444364f45a41512D51a0e942D1F01e8893451F0c.rig1", "0x444364f45a41512D51a0e942D1F01e8893451F0c", "rig1"},
		{"0x444364f45a41512d51a0e942d1f01e8893451f0c/farm-2", "0x444364f45a41512d51a0e942d1f01e8893451f0c", "farm-2"},
	}
	for _, c := range cases {
		a, w := splitLogin(c.in)
		if a != c.addr || w != c.worker {
			t.Fatalf("%s -> %s %s", c.in, a, w)
		}
	}
}
