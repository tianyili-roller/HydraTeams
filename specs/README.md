# OpenAPI Specs

This directory holds downloaded OpenAPI specifications used for Zod schema generation.
The spec files themselves are **gitignored** (large, change often upstream, re-downloadable).

## Sources

| Spec | Source | Format |
|------|--------|--------|
| `anthropic.yml` | [Stainless-hosted](https://storage.googleapis.com/stainless-sdk-openapi-specs/) (resolved dynamically from [anthropic-sdk-python/.stats.yml](https://github.com/anthropics/anthropic-sdk-python/blob/main/.stats.yml)) | OpenAPI 3.1 YAML |
| `openai.yaml` | [openai/openai-openapi](https://github.com/openai/openai-openapi) (`manual_spec` branch) | OpenAPI 3.x YAML |

The Anthropic spec URL contains a content hash that changes with each revision.
The download script in `scripts/download-specs.sh` resolves the latest URL automatically.

## Updating

```bash
# Download specs + regenerate schemas in one step
npm run schemas:update

# Or individually:
npm run specs:download     # download spec files into this directory
npm run schemas:generate   # run @hey-api/openapi-ts codegen
```
