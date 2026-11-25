// Package config loads k8sh settings from ~/.k8sh/config.json.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Tier classifies a kube context. Unknown contexts are treated as prod.
type Tier string

const (
	TierDev     Tier = "dev"
	TierStaging Tier = "staging"
	TierProd    Tier = "prod"
)

type Context struct {
	Tier Tier `json:"tier"`
}

type Config struct {
	// Contexts maps kube context name -> settings. Contexts not listed are prod.
	Contexts map[string]Context `json:"contexts"`
	// MaxGrantTTLMinutes caps grant lifetime. Hard ceiling is 15.
	MaxGrantTTLMinutes int `json:"maxGrantTTLMinutes"`
}

const HardMaxTTLMinutes = 15

// Home returns the k8sh state dir (K8SH_HOME or ~/.k8sh).
func Home() (string, error) {
	if h := os.Getenv("K8SH_HOME"); h != "" {
		return h, nil
	}
	u, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(u, ".k8sh"), nil
}

func EnsureHome() (string, error) {
	h, err := Home()
	if err != nil {
		return "", err
	}
	return h, os.MkdirAll(h, 0o700)
}

func Load() (*Config, error) {
	h, err := Home()
	if err != nil {
		return nil, err
	}
	c := &Config{Contexts: map[string]Context{}}
	b, err := os.ReadFile(filepath.Join(h, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	if c.Contexts == nil {
		c.Contexts = map[string]Context{}
	}
	return c, nil
}

// TierOf returns the tier for a context; unknown means prod (fail safe).
func (c *Config) TierOf(ctx string) Tier {
	if v, ok := c.Contexts[ctx]; ok && v.Tier != "" {
		return v.Tier
	}
	return TierProd
}

func (c *Config) MaxTTLMinutes() int {
	m := c.MaxGrantTTLMinutes
	if m <= 0 || m > HardMaxTTLMinutes {
		return HardMaxTTLMinutes
	}
	return m
}

// Save writes config.json atomically (0600).
func (c *Config) Save() error {
	h, err := EnsureHome()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(h, "config.json.tmp")
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(h, "config.json"))
}

// SetTier labels a context. Tiers are labels for display and policy; they
// never relax the destructive-action lock.
func (c *Config) SetTier(ctx string, t Tier) error {
	switch t {
	case TierDev, TierStaging, TierProd:
	default:
		return errors.New("tier must be dev, staging or prod")
	}
	if ctx == "" {
		return errors.New("context is required")
	}
	if c.Contexts == nil {
		c.Contexts = map[string]Context{}
	}
	c.Contexts[ctx] = Context{Tier: t}
	return nil
}

// SetMaxTTL sets the grant TTL ceiling (1..15 minutes).
func (c *Config) SetMaxTTL(m int) error {
	if m < 1 || m > HardMaxTTLMinutes {
		return errors.New("maxGrantTTLMinutes must be between 1 and 15")
	}
	c.MaxGrantTTLMinutes = m
	return nil
}
