# Agent instructions

## Commit messages

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) for all new commits in this repository.

- Format: `type(scope): description`. The scope is optional; add `!` immediately before `:` for a breaking change.
- Use `feat` for new features and `fix` for bug fixes. Other suitable types include `docs`, `refactor`, `test`, `build`, `ci`, `style`, `perf`, and `chore`.
- Write concise English descriptions and lowercase types. Choose a scope that identifies the affected area when useful.
- Mark breaking changes with `!` or a `BREAKING CHANGE: description` footer. Separate optional bodies and footers with blank lines.
- Apply the same convention to PR titles and squash merge commit messages so merged history follows the convention.

Examples:

```text
feat(publish): offer installation of missing tunnel tools
fix(publish): handle interruption during installation prompts
docs: document conventional commit requirements
```
