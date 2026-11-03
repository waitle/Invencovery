# Third-party notices

recyclewheel itself is released under the MIT License (see [LICENSE](LICENSE)).

`dist/cli.js` is a single bundle that inlines its runtime dependencies, so the plugin runs without `node_modules`.
Redistributing that bundle redistributes the third-party code listed below. Their copyright and license notices follow.

How this list was made: the module graph of the bundle (`src/cli.ts`, esbuild with the settings in `tsup.config.ts`) was
inspected for files under `node_modules/`, the versions come from `package-lock.json` / the installed packages, and the
licenses and copyright lines were read from each package's own `LICENSE` and `package.json`. Re-check this file when the
dependencies change (`npm ls --omit=dev --all`, then the bundle graph).

## 1. Code included in `dist/cli.js`

| Package | Version | License | Included because | Upstream |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | direct | https://github.com/modelcontextprotocol/typescript-sdk |
| `zod` | 4.6.6 | MIT | direct | https://github.com/colinhacks/zod |
| `spdx-expression-parse` | 5.0.0 | MIT | direct | https://github.com/jslicense/spdx-expression-parse.js |
| `tldts` | 7.4.19 | MIT | direct | https://github.com/remusao/tldts |
| `tldts-core` | 7.4.20 | MIT | via tldts | https://github.com/remusao/tldts |
| `ajv` | 8.20.0 | MIT | via @modelcontextprotocol/sdk | https://github.com/ajv-validator/ajv |
| `ajv-formats` | 3.0.1 | MIT | via @modelcontextprotocol/sdk | https://github.com/ajv-validator/ajv-formats |
| `fast-deep-equal` | 3.1.3 | MIT | via ajv | https://github.com/epoberezkin/fast-deep-equal |
| `fast-uri` | 3.1.9 | BSD-3-Clause | via ajv | https://github.com/fastify/fast-uri |
| `json-schema-traverse` | 1.0.0 | MIT | via ajv | https://github.com/epoberezkin/json-schema-traverse |
| `zod-to-json-schema` | 3.25.2 | ISC | via @modelcontextprotocol/sdk | https://github.com/StefanTerdell/zod-to-json-schema |
| `spdx-exceptions` | 2.5.0 | CC-BY-3.0 (data) | via spdx-expression-parse | https://github.com/kemitchell/spdx-exceptions.json |
| `spdx-license-ids` | 3.0.24 | CC0-1.0 (data) | via spdx-expression-parse | https://github.com/jslicense/spdx-license-ids |

Runtime dependencies declared in `package.json` are exactly four: `@modelcontextprotocol/sdk`, `zod`,
`spdx-expression-parse`, `tldts`. The other ten packages are their transitive dependencies that end up in the bundle.
HTTP, SQLite, and the cache server use Node built-ins (`fetch`, `node:sqlite`, `node:http`) and add no third-party code.

## 2. Data sets (not code)

- **spdx-license-ids** (CC0-1.0): list of SPDX license identifiers. Dedicated to the public domain under CC0 1.0.
- **spdx-exceptions** (CC-BY-3.0): list of SPDX license-exception identifiers, copied by its author from the SPDX specification.
  Attribution: "Copyright (c) 2010-2015 Linux Foundation and its Contributors. Licensed under the Creative Commons Attribution
  License 3.0 Unported." (SPDX is a registered trademark of The Linux Foundation.)
  License text: https://creativecommons.org/licenses/by/3.0/legalcode

Both are used only by `spdx-expression-parse` to recognize identifiers in license expressions such as `MIT OR Apache-2.0`.

## 3. License texts

### @modelcontextprotocol/sdk 1.32.1 (MIT)

```text
MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### zod 4.6.6 (MIT)

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### spdx-expression-parse 5.0.0 (MIT)

```text
The MIT License

Copyright (c) 2015 Kyle E. Mitchell & other authors listed in AUTHORS

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### tldts 7.4.19 and tldts-core 7.4.20 (MIT)

```text
Copyright (c) 2017 Thomas Parisot, 2018 Rémi Berson

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### ajv 8.20.0 (MIT)

```text
The MIT License (MIT)

Copyright (c) 2015-2021 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ajv-formats 3.0.1 (MIT)

```text
MIT License

Copyright (c) 2020 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fast-deep-equal 3.1.3 (MIT)

```text
MIT License

Copyright (c) 2017 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fast-uri 3.1.9 (BSD-3-Clause)

```text
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

### json-schema-traverse 1.0.0 (MIT)

```text
MIT License

Copyright (c) 2017 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### zod-to-json-schema 3.25.2 (ISC)

```text
ISC License

Copyright (c) 2020, Stefan Terdell

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## 4. Installed from source but not in the bundle

`npm install` also installs other packages that the MCP SDK declares for features recyclewheel does not use (for example
its HTTP server transports and the `express`, `hono`, and `cross-spawn` dependency trees). The bundle graph contains none
of them, so they are not redistributed with `dist/cli.js`. They stay under their own licenses if you install the project from
source.

Build and test tools are used to develop recyclewheel and are not part of the distributed bundle: `tsup` (MIT, bundles with
`esbuild`, MIT), `typescript` (Apache-2.0), `vitest` (MIT), `@types/node` (MIT), `@types/spdx-expression-parse` (MIT).

## 5. Services called at runtime (not bundled)

recyclewheel sends requests to public APIs and shows their responses to the user. No data from these services is shipped in
this repository. Use of each API is subject to the operator's own terms and rate limits.

- GitHub REST API (`api.github.com`)
- npm registry (`registry.npmjs.org`, `api.npmjs.org`)
- PyPI JSON API (`pypi.org`)
- deps.dev API (`api.deps.dev`)
- Official MCP Registry (`registry.modelcontextprotocol.io`)
- libraries.io API (`libraries.io`), only when `LIBRARIES_IO_API_KEY` is set

## 6. Prior work consulted for ideas (references, not dependencies)

These projects shaped the design (checklist order, scoring axes, candidate tables, search tooling). They are **not**
dependencies and are not bundled. No code or prose from them is included; `skills/recyclewheel/SKILL.md` is written
from scratch (see `docs/PLAN.md` section 4.1).

- `search-first` skills: ECC `search-first`, kisune `search-first`, and shipshitdev `skill-scout`.
- Search tools that recyclewheel recommends but does not wrap or bundle: Grep MCP (grep.app) and the official GitHub MCP server.
- Also looked at: `mcp-pm` and christopher-kapic/context.
