// devminer: minimal CPU Etchash stratum miner for the PRANA payout devnet (open-etc-pool "eth_submitLogin"
// stratum dialect). Also an adversary: it can submit forged, duplicate and stale shares on purpose so
// the pool's rejection paths are exercised end to end.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/etclabscore/go-etchash"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

type blk struct {
	diff *big.Int
	seal common.Hash
	num  uint64
}

func (b blk) Difficulty() *big.Int     { return b.diff }
func (b blk) HashNoNonce() common.Hash { return b.seal }
func (b blk) Nonce() uint64            { return 0 }
func (b blk) MixDigest() common.Hash   { return common.Hash{} }
func (b blk) NumberU64() uint64        { return b.num }

var pow256 = new(big.Int).Lsh(big.NewInt(1), 256)

func epochOfSeed(seed common.Hash) uint64 {
	s := common.Hash{}
	for e := uint64(0); e < 2048; e++ {
		if s == seed {
			return e
		}
		s = crypto.Keccak256Hash(s[:])
	}
	return 0
}

type job struct {
	header, seed, target string
}

func main() {
	pool := flag.String("pool", "127.0.0.1:8008", "stratum host:port")
	login := flag.String("login", "", "payout address (EIP-55)")
	worker := flag.String("worker", "w1", "worker name")
	threads := flag.Int("threads", 2, "search threads")
	maxShares := flag.Int("shares", 0, "exit after N accepted shares (0 = forever)")
	forgeEvery := flag.Int("forge-every", 0, "every N accepted shares, also submit a FORGED share (wrong mix)")
	dupEvery := flag.Int("dup-every", 0, "every N accepted shares, resubmit the last accepted share (duplicate)")
	staleTest := flag.Bool("stale-test", false, "once, submit a share for a header 5 jobs old (stale)")
	bindIP := flag.String("bind", "", "local source IP (e.g. 127.0.0.2) so per-IP pool policy separates miners")
	epochLen := flag.Uint64("epochlen", 60000, "epoch length (ECIP-1099: 60000)")
	flag.Parse()

	// generate the epoch-0 DAG BEFORE connecting (the pool times out silent sessions)
	{
		fb0 := uint64(0)
		pre := etchash.New(&fb0, nil)
		st := make(chan struct{})
		close(st)
		pre.Full.Search(blk{diff: big.NewInt(1), num: 0}, st, 0)
		fmt.Println(`{"event":"dag-ready"}`)
	}
	dialer := net.Dialer{}
	if *bindIP != "" {
		dialer.LocalAddr = &net.TCPAddr{IP: net.ParseIP(*bindIP)}
	}
	conn, err := dialer.Dial("tcp", *pool)
	if err != nil {
		fmt.Println(`{"error":"dial"}`, err)
		os.Exit(1)
	}
	var wmu sync.Mutex
	send := func(m map[string]interface{}) {
		b, _ := json.Marshal(m)
		wmu.Lock()
		conn.Write(append(b, '\n'))
		wmu.Unlock()
	}
	logj := func(m map[string]interface{}) {
		m["t"] = time.Now().Format("15:04:05.000")
		b, _ := json.Marshal(m)
		fmt.Println(string(b))
	}

	jobs := make(chan job, 16)
	type pend struct {
		kind string
		p    []string
	}
	var pmu sync.Mutex
	pending := map[int64]pend{}
	var nextID int64 = 10
	var accepted, rejected int64
	var lastGood []string
	var history []job

	go func() {
		rd := bufio.NewReader(conn)
		for {
			line, err := rd.ReadBytes('\n')
			if err != nil {
				logj(map[string]interface{}{"event": "disconnected", "err": err.Error()})
				os.Exit(1)
			}
			var m struct {
				Id     json.RawMessage `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			json.Unmarshal(line, &m)
			var id int64
			json.Unmarshal(m.Id, &id)
			var arr []string
			if json.Unmarshal(m.Result, &arr) == nil && len(arr) >= 3 && (id == 0 || id == 2) {
				jobs <- job{arr[0], arr[1], arr[2]}
				continue
			}
			pmu.Lock()
			pd, ok := pending[id]
			delete(pending, id)
			pmu.Unlock()
			if ok {
				res := string(m.Result)
				if len(m.Error) > 0 && string(m.Error) != "null" {
					res = string(m.Error)
				}
				good := res == "true"
				if good && pd.kind == "share" {
					atomic.AddInt64(&accepted, 1)
					pmu.Lock()
					lastGood = pd.p
					pmu.Unlock()
				} else {
					atomic.AddInt64(&rejected, 1)
				}
				logj(map[string]interface{}{"event": "reply", "kind": pd.kind, "accepted": good, "reply": res, "nonce": pd.p[0]})
			} else if id == 1 {
				logj(map[string]interface{}{"event": "login", "reply": string(m.Result) + string(m.Error)})
				if string(m.Result) != "true" {
					os.Exit(3)
				}
			}
		}
	}()

	submit := func(kind string, p []string) {
		id := atomic.AddInt64(&nextID, 1)
		pmu.Lock()
		pending[id] = pend{kind, p}
		pmu.Unlock()
		send(map[string]interface{}{"id": id, "method": "eth_submitWork", "params": p, "worker": *worker})
	}

	go func() { // keepalive
		for {
			time.Sleep(20 * time.Second)
			send(map[string]interface{}{"id": 5, "method": "eth_submitHashrate", "params": []string{"0x1", "0x1"}})
		}
	}()
	send(map[string]interface{}{"id": 1, "method": "eth_submitLogin", "params": []string{*login}, "worker": *worker})
	time.Sleep(300 * time.Millisecond)
	send(map[string]interface{}{"id": 2, "method": "eth_getWork", "params": []string{}})

	fb := uint64(0)
	e := etchash.New(&fb, nil)
	var stop chan struct{}
	var cur job
	found := make(chan []string, 64)
	staleDone := false
	sharesSinceForge, sharesSinceDup := 0, 0
	for {
		select {
		case j := <-jobs:
			if j.header == cur.header {
				continue
			}
			if stop != nil {
				close(stop)
			}
			cur = j
			history = append(history, j)
			stop = make(chan struct{})
			tgt := new(big.Int).SetBytes(common.FromHex(j.target))
			diff := new(big.Int).Div(pow256, tgt)
			ep := epochOfSeed(common.HexToHash(j.seed))
			b := blk{diff: diff, seal: common.HexToHash(j.header), num: ep * *epochLen}
			logj(map[string]interface{}{"event": "job", "header": j.header[:18], "shareDiff": diff.String(), "epoch": ep})
			for t := 0; t < *threads; t++ {
				go func(st chan struct{}, hdr string) {
					for {
						n, mix := e.Full.Search(b, st, 0)
						if mix == nil {
							return
						}
						found <- []string{fmt.Sprintf("0x%016x", n), hdr, common.BytesToHash(mix).Hex()}
					}
				}(stop, j.header)
			}
		case p := <-found:
			if p[1] != cur.header {
				continue
			}
			submit("share", p)
			sharesSinceForge++
			sharesSinceDup++
			if *forgeEvery > 0 && sharesSinceForge >= *forgeEvery {
				sharesSinceForge = 0
				f := []string{fmt.Sprintf("0x%016x", time.Now().UnixNano()), p[1], p[2]} // valid-looking, wrong nonce
				submit("forged", f)
			}
			if *dupEvery > 0 && sharesSinceDup >= *dupEvery {
				sharesSinceDup = 0
				pmu.Lock()
				lg := lastGood
				pmu.Unlock()
				if lg != nil {
					submit("duplicate", lg)
				}
			}
			if *staleTest && !staleDone && len(history) > 5 {
				staleDone = true
				old := history[len(history)-6]
				submit("stale", []string{p[0], old.header, p[2]})
			}
			if *maxShares > 0 && int(atomic.LoadInt64(&accepted)) >= *maxShares {
				time.Sleep(500 * time.Millisecond)
				logj(map[string]interface{}{"event": "done", "accepted": accepted, "rejected": rejected})
				return
			}
		}
		_ = strings.ToLower
	}
}
