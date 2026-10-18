package main

// Full-DAG etchash miner: targets NETWORK difficulty to win a real pool block, then submits it.
// Uses go-etchash Full.Search (fast, DAG-backed). Multi-threaded. Exits after a block is accepted.

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
}

func post(url, method string) string {
	b := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"%s","params":[],"id":1}`, method))
	r, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		return ""
	}
	defer r.Body.Close()
	var o struct{ Result string `json:"result"` }
	d, _ := io.ReadAll(r.Body)
	json.Unmarshal(d, &o)
	return o.Result
}
func netDifficulty(url string) *big.Int {
	b := []byte(`{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}`)
	r, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		return big.NewInt(1)
	}
	defer r.Body.Close()
	var o struct{ Result struct{ Difficulty string `json:"difficulty"` } `json:"result"` }
	d, _ := io.ReadAll(r.Body)
	json.Unmarshal(d, &o)
	n := new(big.Int)
	n.SetString(o.Result.Difficulty[2:], 16)
	if n.Sign() == 0 {
		n.SetInt64(1)
	}
	return n
}

func main() {
	stratum, daemon, login := os.Args[1], os.Args[2], os.Args[3]
	threads, _ := strconv.Atoi(os.Args[4])
	durMin, _ := strconv.Atoi(os.Args[5])
	var ecip uint64 = 40000
	hasher := etchash.New(&ecip, nil)

	conn, err := net.Dial("tcp", stratum)
	if err != nil {
		fmt.Println("dial err", err)
		os.Exit(1)
	}
	rd := bufio.NewReader(conn)
	enc := json.NewEncoder(conn)
	send := func(i int, m string, p []interface{}) { enc.Encode(req{ID: i, Method: m, Params: p}) }
	read := func() resp { l, _ := rd.ReadBytes('\n'); var r resp; json.Unmarshal(l, &r); return r }
	send(1, "eth_submitLogin", []interface{}{login, "x"})
	read()

	fmt.Println("generating full DAG for epoch 2 (first search call) ...")
	deadline := time.Now().Add(time.Duration(durMin) * time.Minute)

	for time.Now().Before(deadline) {
		send(2, "eth_getWork", []interface{}{})
		wr := read()
		var work []string
		if json.Unmarshal(wr.Result, &work) != nil || len(work) < 3 {
			time.Sleep(300 * time.Millisecond)
			continue
		}
		header := common.HexToHash(work[0])
		bnHex := post(daemon, "eth_blockNumber")
		bn := new(big.Int)
		if len(bnHex) > 2 {
			bn.SetString(bnHex[2:], 16)
		}
		height := bn.Uint64() + 1
		diff := netDifficulty(daemon)
		blk := myBlock{num: height, diff: diff, hash: header}

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

		// mine this header ~10s then refetch (header likely changed); or stop on solution
		timer := time.NewTimer(10 * time.Second)
		select {
		case s := <-ch:
			close(stop)
			timer.Stop()
			nonceHex := fmt.Sprintf("0x%016x", s.nonce)
			mixHex := "0x" + common.Bytes2Hex(s.mix)
			fmt.Printf("BLOCK SOLUTION height=%d diff=%s header=%s nonce=%s\n", height, diff.String(), work[0][:14], nonceHex)
			send(3, "eth_submitWork", []interface{}{nonceHex, work[0], mixHex})
			sr := read()
			fmt.Printf("  submitWork reply: %s\n", string(sr.Result))
			if string(sr.Result) == "true" {
				fmt.Println("BLOCK ACCEPTED BY POOL")
				return
			}
		case <-timer.C:
			close(stop)
		}
	}
	fmt.Println("done (no block within window)")
}
