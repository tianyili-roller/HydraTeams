---
name: commit
description: Create conventional commits with emoji, diff analysis, and split suggestions
argument-hint: [message] | --amend
context: fork
disable-model-invocation: true
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*)
---

# Git Commit

Create well-formatted commit: $ARGUMENTS

## Current Repository State

- Git status: !`git status --porcelain`
- Current branch: !`git branch --show-current`
- Staged changes: !`git diff --cached --stat`
- Unstaged changes: !`git diff --stat`
- Recent commits: !`git log --oneline -5`

## Workflow

1. Check which files are staged with `git status`
2. If files are already staged, do NOT add anything else — respect the user's intent and only commit what they staged
3. If no files are staged, automatically add all modified and new files with `git add`
3. Run `git diff --cached` to understand what is being committed
4. Analyze the diff for multiple distinct logical changes — if found, suggest splitting into separate commits
5. For each commit, create a message using emoji conventional commit format
6. Execute the commit(s)

## Commit Splitting Criteria

Split when the diff contains:

- **Different concerns**: changes to unrelated parts of the codebase
- **Mixed change types**: features + fixes + refactoring in one diff
- **Distinct file patterns**: source code vs documentation vs config
- **Large diffs**: changes clearer when broken into logical units

When splitting, stage files selectively with `git add <file>` for each commit, then commit, then stage the next group.

## Format Rules

- **Type prefix**: `<emoji> <type>: <description>` (e.g., `✨ feat: add user auth`)
- **Tense**: present tense, imperative mood ("add" not "added")
- **Length**: first line under 72 characters
- **Atomic**: each commit serves a single purpose

## Emoji Conventions

See `references/emoji-conventions.md` for the full emoji mapping table, examples, and commit splitting examples.

## Important Notes

- **Respect staged selections**: if the user has already staged specific files, do NOT run `git add` — commit only what they staged
- If no files are staged, automatically stage all modified and new files
- Always review the diff to ensure the message matches the changes
- Before committing, check if multiple commits would be more appropriate
- If suggesting splits, help stage and commit changes separately
- Verify documentation is updated when relevant
- **Never use `git -C`** — the fork context inherits the correct cwd, so all git commands should run without `-C`
