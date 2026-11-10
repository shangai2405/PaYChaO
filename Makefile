.PHONY: build test cover demo demo-gif vet validate clean

build:
	go build -o bin/paychaos ./cmd/paychaos

cover:
	go test -coverprofile=coverage.out ./internal/... ./cmd/...
	./scripts/check-coverage.sh coverage.out 75

test:
	go test -race -count=1 ./...

vet:
	go vet ./...
	@test -z "$$(gofmt -l .)" || (echo "gofmt needed:"; gofmt -l .; exit 1)

# Checks every bundled scenario file parses and uses known faults.
validate:
	go run ./cmd/paychaos validate examples/scenarios/*.json

demo:
	./scripts/demo.sh

# Regenerates docs/demo.gif from a real run (needs Pillow).
demo-gif:
	./scripts/demo.sh | python3 scripts/render-demo-gif.py docs/demo.gif

clean:
	rm -rf bin coverage.out paychaos-spill-*.ndjson paychaos-report*.json paychaos-*.txt paychaos-*.xml paychaos-*.md
