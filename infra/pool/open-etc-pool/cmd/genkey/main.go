package main

// Generates the pool wallet ON the box. Privkey hex -> file (0600), prints only the public address.
import (
	"encoding/hex"
	"fmt"
	"os"

	"github.com/ethereum/go-ethereum/crypto"
)

func main() {
	path := os.Args[1]
	if b, err := os.ReadFile(path); err == nil && len(b) >= 64 {
		pk, e := crypto.HexToECDSA(string(b[:64]))
		if e == nil {
			fmt.Println("ADDR=" + crypto.PubkeyToAddress(pk.PublicKey).Hex())
			return
		}
	}
	k, err := crypto.GenerateKey()
	if err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
	os.WriteFile(path, []byte(hex.EncodeToString(crypto.FromECDSA(k))), 0600)
	fmt.Println("ADDR=" + crypto.PubkeyToAddress(k.PublicKey).Hex())
}
