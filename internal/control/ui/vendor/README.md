# jsonc-parser

`jsonc-parser.js` bundles only `parseTree` and `createScanner` from Microsoft's
MIT-licensed `jsonc-parser` 3.3.1. It runs locally; no runtime package installation
or remote script is required.

Upstream: https://github.com/microsoft/node-jsonc-parser/tree/v3.3.1

The npm tarball `jsonc-parser-3.3.1.tgz` has integrity:

```text
sha512-HUgH65KyejrUFPvHFPbqOY0rsFip3Bo5wb4ngvdi1EpCYWUQDC5V+Y7mZws+DLkr4M//zQJoanu1SP+87Dv1oQ==
```

To reproduce, extract that tarball to `parser/package`, place this entry beside
`parser/`, and bundle with esbuild 0.25.12:

```js
export {parseTree, createScanner} from './parser/package/lib/esm/main.js';
```

```sh
esbuild ./parser-entry.js --bundle --minify --format=iife --global-name=JSONC \
  --target=es2022 \
  '--banner:js=/* jsonc-parser 3.3.1 (Microsoft), MIT. See licenses/jsonc-parser-LICENSE.txt. */' \
  --outfile=jsonc-parser.js
```

The upstream license is preserved in `licenses/jsonc-parser-LICENSE.txt` at
the repository root and included in the container's license directory.
