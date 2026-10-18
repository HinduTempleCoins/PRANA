// shareverify: independent Etchash share / block verifier for PRANA payout rounds.
//
//	shareverify shares -fblock 0 -mindiff 2000 < bundle_shares.json   (JSON: {"shares":[...],"templates":{...}})
//	shareverify blocks -fblock 0 -rpc https://rpc.prana.melek.salon -from N -to M
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"

	"prana-payout/tools/sealhash"
)

type input struct {
	Shares    []sealhash.Share           `json:"shares"`
	Templates map[string]json.RawMessage `json:"templates"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: shareverify shares|blocks [flags]")
		os.Exit(2)
	}
	mode := os.Args[1]
	fs := flag.NewFlagSet(mode, flag.ExitOnError)
	fblock := fs.Uint64("fblock", 0, "ECIP-1099 activation block (PRANA mainnet genesis: 0)")
	minDiff := fs.Int64("mindiff", 1, "minimum accepted share difficulty")
	rpcURL := fs.String("rpc", "", "RPC URL (blocks mode)")
	from := fs.Uint64("from", 1, "first block")
	to := fs.Uint64("to", 1, "last block")
	threads := fs.Int("threads", runtime.NumCPU()/2+1, "parallel verifications")
	fs.Parse(os.Args[2:])
	v := sealhash.NewVerifier(*fblock)

	switch mode {
	case "shares":
		var in input
		if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
			fmt.Fprintln(os.Stderr, "bad input:", err)
			os.Exit(2)
		}
		res := make([]sealhash.Result, len(in.Shares))
		var wg sync.WaitGroup
		ch := make(chan int)
		for t := 0; t < *threads; t++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range ch {
					s := in.Shares[i]
					res[i] = v.VerifyShare(i, s, in.Templates[strings.ToLower(s.HashNoNonce)], *minDiff)
				}
			}()
		}
		for i := range in.Shares {
			ch <- i
		}
		close(ch)
		wg.Wait()
		ok, bound := 0, 0
		for _, r := range res {
			if r.OK {
				ok++
			}
			if r.Bound {
				bound++
			}
		}
		json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"results": res, "total": len(res), "ok": ok, "bound": bound})
	case "blocks":
		bad := 0
		for n := *from; n <= *to; n++ {
			body, _ := json.Marshal(map[string]interface{}{"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": []interface{}{fmt.Sprintf("0x%x", n), false}})
			resp, err := http.Post(*rpcURL, "application/json", bytes.NewReader(body))
			if err != nil {
				fmt.Println(n, "rpc error", err)
				os.Exit(1)
			}
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var r struct {
				Result sealhash.Header `json:"result"`
			}
			if err := json.Unmarshal(b, &r); err != nil {
				fmt.Println(n, "decode", err)
				os.Exit(1)
			}
			if err := v.VerifyBlock(r.Result); err != nil {
				bad++
				fmt.Printf("block %d FAIL %v\n", n, err)
			} else {
				fmt.Printf("block %d OK seal=%s\n", n, r.Result.SealHash().Hex())
			}
		}
		if bad > 0 {
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown mode")
		os.Exit(2)
	}
}
