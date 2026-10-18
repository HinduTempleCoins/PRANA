package main

// Minimal etchash stratum (ethproxy) miner — proves PRANA pool accepts etchash shares at the correct epoch.
// Cache-based (go-etchash Light.Compute), CPU, low-diff: for verification, not production hashpower.

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
	"time"

	"github.com/ethereum/go-ethereum/common"
	etchash "github.com/etclabscore/go-etchash"
)

type rpcReq struct {
	ID     int           `json:"id"`
	Method string        `json:"method"`
	Params []interface{} `json:"params"`
}
type rpcResp struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  interface{}     `json:"error"`
}

func daemonBlockNumber(url string) uint64 {
	body := []byte(`{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}`)
	r, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return 0
	}
	defer r.Body.Close()
	var out struct {
		Result string `json:"result"`
	}
	b, _ := io.ReadAll(r.Body)
	json.Unmarshal(b, &out)
	n := new(big.Int)
	n.SetString(out.Result[2:], 16)
	return n.Uint64()
}

func main() {
	stratum := os.Args[1] // 127.0.0.1:3333
	daemon := os.Args[2]  // http://127.0.0.1:8557
	login := os.Args[3]   // 0x... miner address
	var ecip uint64 = 40000
	hasher := etchash.New(&ecip, nil)

	conn, err := net.Dial("tcp", stratum)
	if err != nil {
		fmt.Println("DIAL ERR", err)
		os.Exit(1)
	}
	defer conn.Close()
	rd := bufio.NewReader(conn)
	enc := json.NewEncoder(conn)

	send := func(id int, method string, params []interface{}) {
		enc.Encode(rpcReq{ID: id, Method: method, Params: params})
	}
	readResp := func() rpcResp {
		line, _ := rd.ReadBytes('\n')
		var r rpcResp
		json.Unmarshal(line, &r)
		return r
	}

	// login
	send(1, "eth_submitLogin", []interface{}{login, "x"})
	lr := readResp()
	fmt.Printf("login reply: result=%s err=%v\n", string(lr.Result), lr.Error)

	deadline := time.Now().Add(100 * time.Second)
	submitted, accepted := 0, 0
	for time.Now().Before(deadline) {
		// get work
		send(2, "eth_getWork", []interface{}{})
		wr := readResp()
		var work []string
		if err := json.Unmarshal(wr.Result, &work); err != nil || len(work) < 3 {
			// might be a pushed job notification; try reading another line
			time.Sleep(300 * time.Millisecond)
			continue
		}
		header := common.HexToHash(work[0])
		target := new(big.Int)
		target.SetString(work[2][2:], 16)
		blockNum := daemonBlockNumber(daemon)
		if blockNum == 0 {
			blockNum = 156000
		}

		// mine this header for up to ~4s
		start := rand.Uint64()
		stop := time.Now().Add(4 * time.Second)
		found := false
		for i := uint64(0); i < 20000000 && time.Now().Before(stop); i++ {
			nonce := start + i
			mix, result := hasher.Compute(blockNum, header, nonce)
			ri := new(big.Int).SetBytes(result.Bytes())
			if ri.Cmp(target) <= 0 {
				nonceHex := fmt.Sprintf("0x%016x", nonce)
				fmt.Printf("SHARE FOUND header=%s nonce=%s blockNum=%d mix=%s\n", work[0][:14], nonceHex, blockNum, mix.Hex()[:14])
				send(3, "eth_submitWork", []interface{}{nonceHex, work[0], mix.Hex()})
				sr := readResp()
				submitted++
				ok := string(sr.Result) == "true"
				if ok {
					accepted++
				}
				fmt.Printf("  SUBMIT reply: result=%s err=%v  => %s\n", string(sr.Result), sr.Error, map[bool]string{true: "ACCEPTED", false: "REJECTED"}[ok])
				found = true
				break
			}
		}
		if !found {
			fmt.Printf("no share this round (header=%s target=%s)\n", work[0][:14], work[2][:14])
		}
		if accepted >= 3 {
			break
		}
	}
	fmt.Printf("DONE submitted=%d accepted=%d\n", submitted, accepted)
}
