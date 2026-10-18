package proxy

import (
	"github.com/etclabscore/open-etc-pool/api"
	"github.com/etclabscore/open-etc-pool/payouts"
	"github.com/etclabscore/open-etc-pool/policy"
	"github.com/etclabscore/open-etc-pool/storage"
)

type Config struct {
	Name                  string        `json:"name"`
	Proxy                 Proxy         `json:"proxy"`
	Api                   api.ApiConfig `json:"api"`
	Upstream              []Upstream    `json:"upstream"`
	UpstreamCheckInterval string        `json:"upstreamCheckInterval"`

	Threads int `json:"threads"`

	Network string         `json:"network"`
	// PRANA: ECIP-1099 activation height for the share verifier (PRANA mainnet genesis: 0).
	Ecip1099FBlock *uint64 `json:"ecip1099FBlock"`
	Coin    string         `json:"coin"`
	Redis   storage.Config `json:"redis"`

	BlockUnlocker payouts.UnlockerConfig `json:"unlocker"`
	Payouts       payouts.PayoutsConfig  `json:"payouts"`

	NewrelicName    string `json:"newrelicName"`
	NewrelicKey     string `json:"newrelicKey"`
	NewrelicVerbose bool   `json:"newrelicVerbose"`
	NewrelicEnabled bool   `json:"newrelicEnabled"`
}

type Proxy struct {
	Enabled              bool   `json:"enabled"`
	Listen               string `json:"listen"`
	LimitHeadersSize     int    `json:"limitHeadersSize"`
	LimitBodySize        int64  `json:"limitBodySize"`
	BehindReverseProxy   bool   `json:"behindReverseProxy"`
	BlockRefreshInterval string `json:"blockRefreshInterval"`
	Difficulty           int64  `json:"difficulty"`
	StateUpdateInterval  string `json:"stateUpdateInterval"`
	HashrateExpiration   string `json:"hashrateExpiration"`

	Policy policy.Config `json:"policy"`

	MaxFails    int64 `json:"maxFails"`
	HealthCheck bool  `json:"healthCheck"`

	Stratum Stratum `json:"stratum"`

	// PRANA payout hardening
	RequireChecksum bool     `json:"requireChecksum"` // logins must be EIP-55 checksummed
	DenyLogins      []string `json:"denyLogins"`      // e.g. the pot contract, the Hathor treasury
	TemplateBinding bool     `json:"templateBinding"` // record the full header of every work template
}

type Stratum struct {
	Enabled bool   `json:"enabled"`
	Listen  string `json:"listen"`
	Timeout string `json:"timeout"`
	MaxConn int    `json:"maxConn"`
}

type Upstream struct {
	Name    string `json:"name"`
	Url     string `json:"url"`
	Timeout string `json:"timeout"`
}
