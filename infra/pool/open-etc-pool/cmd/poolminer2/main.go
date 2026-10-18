package main

// Multi-threaded etchash stratum miner for the block-find proof. Shared cache (go-etchash Light),
// N goroutines each with its own stratum connection. Runs for durationSec. Low diff => finds shares fast;
// ~1/(netDiff/shareDiff) of them also meet network difficulty => a real block.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"math/rand"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	etchash "github.com/etclabscore/go-etchash"
	"github.com/ethereum/go-ethereum/common"
)

type req struct {
	ID     int           `json:"id"`
	Method string        `json:"method"`
	Params []interface{} `json:"params"`
}
type resp struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  interface{}     `json:"error"`
}

var hasher *etchash.Etchash
var submitted, accepted int64

func blockNumber(url string) uint64 {
	b := []byte(`{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}`)
	r, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		return 0
	}
	defer r.Body.Close()
	var o struct{ Result string `json:"result"` }
	d, _ := io.ReadAll(r.Body)
	json.Unmarshal(d, &o)
	n := new(big.Int)
	n.SetString(o.Result[2:], 16)
	return n.Uint64()
}

func worker(id int, stratum, daemon, login string, stopAt time.Time) {
	conn, err := net.Dial("tcp", stratum)
	if err != nil {
		fmt.Printf("w%d dial err %v\n", id, err)
		return
	}
	defer conn.Close()
	rd := bufio.NewReader(conn)
	enc := json.NewEncoder(conn)
	send := func(i int, m string, p []interface{}) { enc.Encode(req{ID: i, Method: m, Params: p}) }
	read := func() resp { l, _ := rd.ReadBytes('\n'); var r resp; json.Unmarshal(l, &r); return r }
	send(1, "eth_submitLogin", []interface{}{login, "x"})
	read()
	for time.Now().Before(stopAt) {
		send(2, "eth_getWork", []interface{}{})
		wr := read()
		var work []string
		if json.Unmarshal(wr.Result, &work) != nil || len(work) < 3 {
			time.Sleep(200 * time.Millisecond)
			continue
		}
		header := common.HexToHash(work[0])
		target := new(big.Int)
		target.SetString(work[2][2:], 16)
		bn := blockNumber(daemon)
		if bn == 0 {
			bn = 156000
		}
		start := rand.Uint64()
		stop := time.Now().Add(3 * time.Second)
		for i := uint64(0); time.Now().Before(stop); i++ {
			nonce := start + i
			mix, result := hasher.Compute(bn, header, nonce)
			if new(big.Int).SetBytes(result.Bytes()).Cmp(target) <= 0 {
				send(3, "eth_submitWork", []interface{}{fmt.Sprintf("0x%016x", nonce), work[0], mix.Hex()})
				sr := read()
				atomic.AddInt64(&submitted, 1)
				if string(sr.Result) == "true" {
					atomic.AddInt64(&accepted, 1)
				}
				break
			}
		}
	}
}

func main() {
	stratum, daemon, login := os.Args[1], os.Args[2], os.Args[3]
	threads, _ := strconv.Atoi(os.Args[4])
	dur, _ := strconv.Atoi(os.Args[5])
	var ecip uint64 = 40000
	hasher = etchash.New(&ecip, nil)
	// warm the cache once
	hasher.Compute(blockNumber(daemon), common.Hash{}, 0)
	stopAt := time.Now().Add(time.Duration(dur) * time.Second)
	for i := 0; i < threads; i++ {
		go worker(i, stratum, daemon, login, stopAt)
		time.Sleep(50 * time.Millisecond)
	}
	for time.Now().Before(stopAt) {
		time.Sleep(5 * time.Second)
		fmt.Printf("[%s] submitted=%d accepted=%d\n", time.Now().UTC().Format("15:04:05"), atomic.LoadInt64(&submitted), atomic.LoadInt64(&accepted))
	}
	fmt.Printf("DONE submitted=%d accepted=%d\n", submitted, accepted)
}
