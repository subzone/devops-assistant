// Package mcp is a minimal, dependency-free MCP server (JSON-RPC 2.0 over
// newline-delimited stdio) exposing k8sh tools.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

const ProtocolVersion = "2025-06-18"

type Annotations struct {
	Title           string `json:"title,omitempty"`
	ReadOnlyHint    bool   `json:"readOnlyHint"`
	DestructiveHint bool   `json:"destructiveHint"`
	IdempotentHint  bool   `json:"idempotentHint,omitempty"`
	OpenWorldHint   bool   `json:"openWorldHint,omitempty"`
}

type Handler func(ctx context.Context, args map[string]any) (any, error)

type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations Annotations    `json:"annotations"`
	handler     Handler
}

type Server struct {
	Name, Version string
	Instructions  string
	tools         []*Tool
	byName        map[string]*Tool
	mu            sync.Mutex
}

func NewServer(name, version string) *Server {
	return &Server{Name: name, Version: version, byName: map[string]*Tool{}}
}

func (s *Server) Add(t Tool, h Handler) {
	t.handler = h
	if t.InputSchema == nil {
		t.InputSchema = Obj(nil)
	}
	s.tools = append(s.tools, &t)
	s.byName[t.Name] = &t
}

func (s *Server) Tools() []*Tool { return s.tools }

type req struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type resp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcErr         `json:"error,omitempty"`
}

// Serve reads requests from r and writes responses to w until EOF.
func (s *Server) Serve(ctx context.Context, r io.Reader, w io.Writer) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	enc := json.NewEncoder(w)
	var wmu sync.Mutex
	send := func(v any) {
		wmu.Lock()
		defer wmu.Unlock()
		enc.Encode(v)
	}
	var wg sync.WaitGroup
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		if len(line) == 0 {
			continue
		}
		var q req
		if err := json.Unmarshal(line, &q); err != nil {
			send(resp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcErr{-32700, "parse error"}})
			continue
		}
		if len(q.ID) == 0 { // notification
			continue
		}
		wg.Add(1)
		go func(q req) {
			defer wg.Done()
			res, e := s.handle(ctx, q)
			send(resp{JSONRPC: "2.0", ID: q.ID, Result: res, Error: e})
		}(q)
	}
	wg.Wait()
	return sc.Err()
}

func (s *Server) handle(ctx context.Context, q req) (any, *rpcErr) {
	switch q.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(q.Params, &p)
		v := ProtocolVersion
		if p.ProtocolVersion != "" {
			v = p.ProtocolVersion
		}
		return map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": s.Name, "version": s.Version},
			"instructions":    s.Instructions,
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": s.tools}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(q.Params, &p); err != nil {
			return nil, &rpcErr{-32602, "invalid params"}
		}
		t, ok := s.byName[p.Name]
		if !ok {
			return nil, &rpcErr{-32602, "unknown tool " + p.Name}
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		out, err := t.handler(ctx, p.Arguments)
		if err != nil {
			return textResult(err.Error(), true), nil
		}
		var text string
		switch v := out.(type) {
		case string:
			text = v
		default:
			b, _ := json.MarshalIndent(v, "", "  ")
			text = string(b)
		}
		return textResult(text, false), nil
	case "resources/list":
		return map[string]any{"resources": []any{}}, nil
	case "prompts/list":
		return map[string]any{"prompts": []any{}}, nil
	}
	return nil, &rpcErr{-32601, "method not found: " + q.Method}
}

func textResult(text string, isErr bool) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": isErr,
	}
}

// --- schema helpers ---

func Obj(props map[string]any, required ...string) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	m := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

func Str(desc string) map[string]any  { return map[string]any{"type": "string", "description": desc} }
func Bool(desc string) map[string]any { return map[string]any{"type": "boolean", "description": desc} }
func Int(desc string) map[string]any  { return map[string]any{"type": "integer", "description": desc} }

// Arg helpers
func S(a map[string]any, k string) string { v, _ := a[k].(string); return v }
func B(a map[string]any, k string, def bool) bool {
	if v, ok := a[k].(bool); ok {
		return v
	}
	return def
}
func I(a map[string]any, k string, def int) int {
	switch v := a[k].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return def
}

func Errf(f string, a ...any) error { return fmt.Errorf(f, a...) }
