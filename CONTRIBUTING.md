# Contributing

Development commands, from the repository root:

```bash
pnpm install
pnpm typecheck
pnpm typecheck:examples
pnpm test
pnpm test:coverage
pnpm pack:check
```

Optional for local DX: install Turbo globally with `pnpm add --global turbo`.
The repo scripts still use the local workspace version.

## Documentation

The documentation is Spanish-first. `README.md` is the package front door and
`docs/` is a Mintlify site organized into getting-started, guides, reference,
and resources. `docs/en/overview.mdx` is a short English summary.
`docs/reference/arca-sources.mdx` is a maintainer ledger of the ARCA manual
rules the SDK encodes; it stays in English.

`packages/arca/README.md` is a byte-identical copy of `README.md`. After
editing the root README, run:

```bash
pnpm docs:sync
pnpm check:docs
```

`pnpm check:docs` also verifies that every repository or Mintlify-internal link
and heading anchor in `README.md`, `docs/**/*.mdx` and
`packages/arca/README.md` resolves, and that every file in `examples/` is
linked from at least one document. It runs in CI.
