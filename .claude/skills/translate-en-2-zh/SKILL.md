---
name: translating-docs-en-to-zh
description: Translates English repository documentation (README, guides, API docs) to Chinese. Use when asked to translate English .md files to Chinese, or when user mentions 翻译, 中文翻译, or Chinese translation of docs.
---

# Translate English Repo Docs to Chinese

Translate $ARGUMENTS to Chinese. If no file specified, ask which files to translate.

## Do NOT translate

- Code blocks, commands, variables, file paths
- Code comments: translate only if user-facing (e.g. tutorial code samples)
- Lib/tool/product names (LangChain, Docker, Redis, etc.)
- AI/ML concepts: agent, agent-teams, react loop, tool calling, chain-of-thought, RAG, MCP, prompt, embedding, fine-tuning, etc.
- First occurrence of translated terms: use 中文(English) format, then Chinese only

## Style rules

- Natural Chinese. Rewrite for clarity, not literal translation
- No stacked 的的的 or long pre-modifiers
- Space between CJK and half-width: "使用 Docker 部署"
- Full-width punctuation in Chinese context
- Concise > faithful

## Structure

- Preserve markdown structure, headings, links
- Update anchor links if headings translated
- Code blocks: unchanged
- Tables: translate content cells only

## Output

- Save as `{original_name}.zh-CN.md` in same directory
- Add at file top:

```
  > 翻译基于 [英文版 commit xxx](link) | [English Version](link)
```
