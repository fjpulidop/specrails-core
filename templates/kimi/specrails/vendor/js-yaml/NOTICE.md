# Vendored js-yaml

This directory contains the unmodified ESM distribution and MIT license from
[`js-yaml` 4.1.1](https://www.npmjs.com/package/js-yaml/v/4.1.1).

- Source package: `js-yaml@4.1.1`
- Source file: `dist/js-yaml.mjs`
- `js-yaml.mjs` SHA-256:
  `efbc45850bf15f0c8ee3434983f512be656002d7507dc292c7ade4449b5d57fa`
- `LICENSE` SHA-256:
  `a07bc24468b9654ce76a547d47a2db282d07733b715db4c73a98bd63961f9550`

SpecRails vendors this parser so `.kimi-code/specrails/run-skill.mjs` can apply
Kimi-compatible YAML frontmatter semantics without depending on the target
project's `node_modules`. The files are copied, updated, checksummed, and
diagnosed as one managed runtime bundle.
