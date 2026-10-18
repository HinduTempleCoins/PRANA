package main

// Continuous etchash stratum miner (full DAG, CPU, multi-threaded) — our own hashrate through the PRANA pool,
// exactly the way an outside miner connects. It searches at SHARE difficulty (not network difficulty), submits
// every share over stratum, and the pool turns any share that also meets network difficulty into a block.
// Re-fetches work every 2s and on every solution; reconnects if the pool drops it. Runs forever.
//
//   poolminer-run <stratum host:port> <daemon rpc url> <login 0x…> <threads> <share difficulty>

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	etchash "github.com/etclabscore/go-etchash"
	"github.com/ethereum/go-ethereum/common"
)

type myBlock struct {
	num  uint64
	diff *big.Int
	hash common.Hash
}

func (b myBlock) NumberU64() uint64        { return b.num }
func (b myBlock) Difficulty() *big.Int     { return b.diff }
func (b myBlock) HashNoNonce() common.Hash { return b.hash }
func (b myBlock) Nonce() uint64            { return 0 }
func (b myBlock) MixDigest() common.Hash   { return common.Hash{} }

type req struct {
	ID     int           `json:"id"`
	Method string        `json:"method"`
	Params []interface{} `json:"params"`
}
type resp struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

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
	if len(o.Result) > 2 {
		n.SetString(o.Result[2:], 16)
	}
	return n.Uint64()
}

func session(stratum, daemon, login string, threads int, shareDiff *big.Int, hasher *etchash.Etchash, stats *[2]int) error {
	conn, err := net.DialTimeout("tcp", stratum, 10*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	rd := bufio.NewReader(conn)
	enc := json.NewEncoder(conn)
	call := func(i int, m string, p []interface{}) (resp, error) {
		conn.SetDeadline(time.Now().Add(30 * time.Second))
		if err := enc.Encode(req{ID: i, Method: m, Params: p}); err != nil {
			return resp{}, err
		}
		// the pool pushes new work on every block (id 0, unasked); skip pushes until the reply to THIS call
		for {
			l, err := rd.ReadBytes(10)
			if err != nil {
				return resp{}, err
			}
			var r resp
			json.Unmarshal(l, &r)
			if r.ID == i {
				return r, nil
			}
		}
	}
	if _, err := call(1, "eth_submitLogin", []interface{}{login, "x"}); err != nil {
		return err
	}
	for {
		wr, err := call(2, "eth_getWork", []interface{}{})
		if err != nil {
			return err
		}
		var work []string
		if json.Unmarshal(wr.Result, &work) != nil || len(work) < 3 {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		height := blockNumber(daemon) + 1
		blk := myBlock{num: height, diff: shareDiff, hash: common.HexToHash(work[0])}
		stop := make(chan struct{})
		type sol struct {
			nonce uint64
			mix   []byte
		}
		ch := make(chan sol, threads)
		for t := 0; t < threads; t++ {
			go func(idx int) {
				n, mix := hasher.Search(blk, stop, idx)
				if mix != nil {
					select {
					case ch <- sol{n, mix}:
					default:
					}
				}
			}(t)
		}
		// poll for new work every 300ms; the moment the header changes (a new block), drop the stale search
		tick := time.NewTicker(300 * time.Millisecond)
		done := false
		for !done {
			select {
			case s := <-ch:
				close(stop)
				tick.Stop()
				done = true
				sr, err := call(3, "eth_submitWork", []interface{}{fmt.Sprintf("0x%016x", s.nonce), work[0], "0x" + common.Bytes2Hex(s.mix)})
				if err != nil {
					return err
				}
				if string(sr.Result) == "true" {
					stats[0]++
				} else {
					stats[1]++
				}
			case <-tick.C:
				nr, err := call(2, "eth_getWork", []interface{}{})
				if err != nil {
					close(stop)
					tick.Stop()
					return err
				}
				var nw []string
				if json.Unmarshal(nr.Result, &nw) == nil && len(nw) >= 3 && nw[0] != work[0] {
					close(stop)
					tick.Stop()
					done = true
				}
			}
		}
	}
}

func main() {
	stratum, daemon, login := os.Args[1], os.Args[2], os.Args[3]
	threads, _ := strconv.Atoi(os.Args[4])
	sd, _ := strconv.ParseInt(os.Args[5], 10, 64)
	shareDiff := big.NewInt(sd)
	var ecip uint64 = 40000
	hasher := etchash.New(&ecip, nil)
	var stats [2]int
	go func() {
		for range time.Tick(60 * time.Second) {
			fmt.Printf("{\"accepted\":%d,\"rejected\":%d,\"shareDiff\":%d,\"threads\":%d}\n", stats[0], stats[1], sd, threads)
		}
	}()
	for {
		err := session(stratum, daemon, login, threads, shareDiff, hasher, &stats)
		fmt.Printf("{\"reconnect\":%q}\n", fmt.Sprint(err))
		time.Sleep(5 * time.Second)
	}
}
