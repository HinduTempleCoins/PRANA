package storage

import (
	"testing"
	"time"
)

// Requires a scratch redis on 127.0.0.1:6390 (started by the test harness, never the live pool's).
func TestShareLogAndBlockIndex(t *testing.T) {
	r := NewRedisClient(&Config{Endpoint: "127.0.0.1:6390", PoolSize: 2, Database: 0}, "t")
	if _, err := r.Check(); err != nil {
		t.Skip("scratch redis not running:", err)
	}
	r.client.FlushDb()
	if _, err := r.WriteShare("0xaa", "w1", []string{"0x1", "0x2", "0x3"}, 500, 10, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := r.WriteBlock("0xbb", "w2", []string{"0x4", "0x5", "0x6"}, 500, 9999, 11, time.Hour); err != nil {
		t.Fatal(err)
	}
	l, _ := r.client.LRange("t:pplns", 0, -1).Result()
	if len(l) != 2 || l[0][:7] != "h:0xbb:" || l[1][:7] != "h:0xaa:" {
		t.Fatalf("share log wrong: %v", l)
	}
	c, _ := r.client.ZRangeWithScores("t:blocks:candidates", 0, -1).Result()
	if len(c) != 1 {
		t.Fatalf("candidate missing: %v", c)
	}
	// totalShares (last field) must still be computed from the round map: 500+500
	m := c[0].Member.(string)
	if m[len(m)-5:] != ":1000" {
		t.Fatalf("totalShares wrong in candidate row: %s", m)
	}
}
