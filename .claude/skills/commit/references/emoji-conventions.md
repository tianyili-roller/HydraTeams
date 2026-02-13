# Emoji Conventional Commit Conventions

## Primary Types

| Emoji | Type | Description |
|-------|------|-------------|
| ✨ | `feat` | New feature |
| 🐛 | `fix` | Bug fix |
| 📝 | `docs` | Documentation |
| 💄 | `style` | Formatting/style |
| ♻️ | `refactor` | Code refactoring |
| ⚡️ | `perf` | Performance improvements |
| ✅ | `test` | Tests |
| 🔧 | `chore` | Tooling, configuration |
| 🚀 | `ci` | CI/CD improvements |
| 🗑️ | `revert` | Reverting changes |

## Extended Mappings

| Emoji | Type | Description |
|-------|------|-------------|
| 🧪 | `test` | Add a failing test |
| 🚨 | `fix` | Fix compiler/linter warnings |
| 🔒️ | `fix` | Fix security issues |
| 👥 | `chore` | Add or update contributors |
| 🚚 | `refactor` | Move or rename resources |
| 🏗️ | `refactor` | Make architectural changes |
| 🔀 | `chore` | Merge branches |
| 📦️ | `chore` | Add or update compiled files or packages |
| ➕ | `chore` | Add a dependency |
| ➖ | `chore` | Remove a dependency |
| 🌱 | `chore` | Add or update seed files |
| 🧑‍💻 | `chore` | Improve developer experience |
| 🧵 | `feat` | Add or update multithreading/concurrency code |
| 🔍️ | `feat` | Improve SEO |
| 🏷️ | `feat` | Add or update types |
| 💬 | `feat` | Add or update text and literals |
| 🌐 | `feat` | Internationalization and localization |
| 👔 | `feat` | Add or update business logic |
| 📱 | `feat` | Work on responsive design |
| 🚸 | `feat` | Improve user experience / usability |
| 🩹 | `fix` | Simple fix for a non-critical issue |
| 🥅 | `fix` | Catch errors |
| 👽️ | `fix` | Update code due to external API changes |
| 🔥 | `fix` | Remove code or files |
| 🎨 | `style` | Improve structure/format of the code |
| 🚑️ | `fix` | Critical hotfix |
| 🎉 | `chore` | Begin a project |
| 🔖 | `chore` | Release/Version tags |
| 🚧 | `wip` | Work in progress |
| 💚 | `fix` | Fix CI build |
| 📌 | `chore` | Pin dependencies to specific versions |
| 👷 | `ci` | Add or update CI build system |
| 📈 | `feat` | Add or update analytics or tracking code |
| ✏️ | `fix` | Fix typos |
| ⏪️ | `revert` | Revert changes |
| 📄 | `chore` | Add or update license |
| 💥 | `feat` | Introduce breaking changes |
| 🍱 | `assets` | Add or update assets |
| ♿️ | `feat` | Improve accessibility |
| 💡 | `docs` | Add or update comments in source code |
| 🗃️ | `db` | Perform database related changes |
| 🔊 | `feat` | Add or update logs |
| 🔇 | `fix` | Remove logs |
| 🤡 | `test` | Mock things |
| 🥚 | `feat` | Add or update an easter egg |
| 🙈 | `chore` | Add or update .gitignore file |
| 📸 | `test` | Add or update snapshots |
| ⚗️ | `experiment` | Perform experiments |
| 🚩 | `feat` | Add, update, or remove feature flags |
| 💫 | `ui` | Add or update animations and transitions |
| ⚰️ | `refactor` | Remove dead code |
| 🦺 | `feat` | Add or update code related to validation |
| ✈️ | `feat` | Improve offline support |

## Good Commit Message Examples

- ✨ feat: add user authentication system
- 🐛 fix: resolve memory leak in rendering process
- 📝 docs: update API documentation with new endpoints
- ♻️ refactor: simplify error handling logic in parser
- 🚨 fix: resolve linter warnings in component files
- 🧑‍💻 chore: improve developer tooling setup process
- 👔 feat: implement business logic for transaction validation
- 🩹 fix: address minor styling inconsistency in header
- 🚑️ fix: patch critical security vulnerability in auth flow
- 🎨 style: reorganize component structure for better readability
- 🔥 fix: remove deprecated legacy code
- 🦺 feat: add input validation for user registration form
- 💚 fix: resolve failing CI pipeline tests
- 📈 feat: implement analytics tracking for user engagement
- 🔒️ fix: strengthen authentication password requirements
- ♿️ feat: improve form accessibility for screen readers

## Commit Splitting Example

When a diff contains multiple concerns, split into separate commits:

1. ✨ feat: add new solc version type definitions
2. 📝 docs: update documentation for new solc versions
3. 🔧 chore: update package.json dependencies
4. 🏷️ feat: add type definitions for new API endpoints
5. 🧵 feat: improve concurrency handling in worker threads
6. 🚨 fix: resolve linting issues in new code
7. ✅ test: add unit tests for new solc version features
8. 🔒️ fix: update dependencies with security vulnerabilities
