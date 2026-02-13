---
name: review-codex-answer
description: >
  Fetch the latest final_answer from a local Codex CLI session for cross-agent review.
  Trigger: /review-codex-answer slash command. Use when the user wants to see what Codex replied,
  compare Codex's answer with Claude Code's own analysis, or cross-check plans/bugfixes
  between Claude Code and Codex.
disable-model-invocation: true
allowed-tools: Bash(uv run *)
---

# Review Codex Answer

Retrieve and display the most recent Codex final_answer from local session files (`~/.codex/sessions/`), filtered to the current project by cwd.

## Workflow

1. Run the extraction script with the current working directory:

```bash
uv run <skill-path>/scripts/get_codex_final_answer.py --cwd "$PWD"
```

2. Parse the JSON output. Present to the user:
   - Source file path and timestamp
   - The full `text` content, rendered as markdown
   - Total number of final_answers available in that session

3. Use the **AskUserQuestion** tool to confirm:
   - Question: "Is this the Codex answer you want to review?"
   - Options: "Yes, review this one" / "No, show me the previous one"
   - If **yes** — proceed to step 4.
   - If **no** — re-run with `--offset N` (start with 1, increment) to fetch the previous final_answer, then ask again:

```bash
uv run <skill-path>/scripts/get_codex_final_answer.py --cwd "$PWD" --offset 1
```

4. Once confirmed, perform a **cross-review** of the Codex answer against your own prior analysis in this conversation. Address the following:
   - Did you and the other engineer identify the **same root causes / key points**?
   - Is your analysis **better or worse** than theirs? In what ways?
   - Is there anything you can **learn from** their content?
   - Is there anything **missing in their analysis** that you covered, or vice versa?

5. If the script returns an `error` key in JSON, report the error to the user.

## Script behavior

- `--cwd` is **required**. Always pass `"$PWD"` so the script filters to the current project. Do not hardcode a path.
- The script scans all JSONL files under `~/.codex/sessions/`, matches each session's cwd (from `session_meta` payload) against the given `--cwd` (both resolved to handle symlinks/trailing slashes).
- Sessions with a different cwd are skipped entirely.
- The script collects final_answers from up to 3 cwd-matching sessions (newest first), merging them into a single list ordered newest-first.
- `--offset N` indexes into this merged list. offset=0 is the very latest answer, offset=1 is the one before it, etc. Offset spans across sessions.
- Output is a single JSON object: `{source_file, total_final_answers, selected_index, timestamp, text}` on success, or `{error}` on failure.

## Notes

- `<skill-path>` refers to the directory containing this SKILL.md.
