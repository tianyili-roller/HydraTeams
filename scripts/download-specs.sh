#!/usr/bin/env bash
set -euo pipefail

SPECS_DIR="$(cd "$(dirname "$0")/.." && pwd)/specs"
mkdir -p "$SPECS_DIR"

# ─── Anthropic ────────────────────────────────────────────────
# Dynamically resolve the latest spec URL from the official SDK repo.
# Anthropic doesn't publish a standalone OpenAPI spec, but Stainless
# (their SDK generator) hosts one. The URL is in .stats.yml.
echo "Fetching Anthropic spec URL from anthropic-sdk-python/.stats.yml..."
STATS_URL="https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/.stats.yml"
ANTHROPIC_SPEC_URL=$(curl -sL "$STATS_URL" | grep 'openapi_spec_url:' | sed 's/openapi_spec_url: *//')

if [ -z "$ANTHROPIC_SPEC_URL" ]; then
  echo "ERROR: Could not extract openapi_spec_url from .stats.yml" >&2
  exit 1
fi

echo "Downloading Anthropic spec..."
curl -sL -o "$SPECS_DIR/anthropic.yml" "$ANTHROPIC_SPEC_URL"

# ─── OpenAI ───────────────────────────────────────────────────
# Official spec from the openai/openai-openapi repo (manual_spec branch).
echo "Downloading OpenAI spec..."
curl -sL -o "$SPECS_DIR/openai.yaml" \
  "https://raw.githubusercontent.com/openai/openai-openapi/refs/heads/manual_spec/openapi.yaml"

echo "Done. Specs saved to $SPECS_DIR/"
ls -lh "$SPECS_DIR"/anthropic.yml "$SPECS_DIR"/openai.yaml
