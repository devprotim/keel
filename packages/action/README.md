# Keel architecture check

A GitHub Action that runs Keel's rule engine over the diagrams committed to a repository. On a pull request, it reports what the change introduces and what it resolves.

It runs the same deterministic rules as the canvas and `POST /api/validate`: missing timeouts, single points of failure, retry storms, unapproved changes to the baseline, and the rest. There is no network call and no AI, so the result is the same on every run.

## What it does

1. Finds diagram files (Keel's **Export → JSON**, by default anything matching `**/*.keel.json`).
2. Validates each one, including against its approved baseline if the file carries one.
3. On a pull request, validates the same file at the base commit and compares the two. A finding is identified by its rule and the ids it cites, not its wording, so renaming a component does not make its findings look new.
4. Reports in three places:
   - one pull request comment, edited in place on each push rather than repeated,
   - the job summary,
   - annotations on the diagram file, at the line where the cited component or call is declared.
5. Fails the job only if you ask it to (see `fail-on`).

## Usage

```yaml
permissions:
  contents: read
  pull-requests: write # for the comment; everything else works without it

steps:
  - uses: actions/checkout@v4
  - uses: <owner>/keel/packages/action@v1
    with:
      diagrams: architecture/*.keel.json
      fail-on: error
```

More in [`examples/`](examples): [report only](examples/report-only.yml), [block new errors](examples/gate-new-errors.yml), and [strict](examples/strict.yml).

## Inputs

| Input | Default | |
|---|---|---|
| `diagrams` | `**/*.keel.json` | Globs, separated by commas or newlines. `node_modules` and `.git` are skipped. |
| `fail-on` | `never` | Lowest severity that fails the job: `error`, `warning`, `info`, or `never` to report only. |
| `fail-scope` | `new` | `new` fails only on findings the change introduces. `all` fails on any finding. |
| `disabled-rules` | | Rule ids to skip, separated by commas, e.g. `orphan-node`. |
| `comment` | `true` | Post the report as a pull request comment. |
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` to comment. |

## Outputs

`findings`, `introduced`, `resolved`, and `blocking`, all counts.

## Behaviour worth knowing

- **Unreadable diagrams always fail**, even with `fail-on: never`. A check that quietly passes a file it could not read is worse than no check.
- **No base, no "new".** On a push event, or if the base commit cannot be fetched, nothing can be compared, so `fail-scope: new` falls back to every finding rather than none. The action fetches the base commit itself if the checkout is shallow, so `fetch-depth: 0` is not needed.
- **A new file** counts all of its findings as new.
- **Forks.** A pull request from a fork gets a read-only token, so the comment can't be posted. The action logs a warning and still reports through the summary and annotations.

## Getting a diagram into the repository

In Keel, **Export → JSON** writes the graph and its approved baseline in the format this action reads. Commit it next to the code it describes. The file is plain, stable JSON, so changes to it diff and review like code.

## Development

```bash
pnpm --filter @keel/shared build
pnpm --filter @keel/action test
pnpm --filter @keel/action build   # writes dist/index.cjs, which is committed
```

`dist/index.cjs` is what the runner executes, so it is committed. CI rebuilds it and fails if the committed copy is stale.
