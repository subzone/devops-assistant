.PHONY: build test vet dist
build:
	CGO_ENABLED=0 go build -trimpath -o bin/k8sh ./cmd/k8sh
test:
	go test ./...
vet:
	go vet ./...
dist:
	@for p in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64; do \
	  os=$${p%/*}; arch=$${p#*/}; ext=; [ $$os = windows ] && ext=.exe; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "-s -w" -o dist/k8sh-$$os-$$arch$$ext ./cmd/k8sh; \
	done
