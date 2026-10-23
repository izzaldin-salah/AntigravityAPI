# OpenCode / MCP tool-schema compatibility fix

Prepared locally on 2026-10-24. No deployment, Git push, OpenCode configuration
change, credential migration, new dependency or environment setting is required
by this fix.

## Cause and scope

The tool normalizer used the smaller CCA Claude denylist and forwarded unknown
fields. The Google/Cloud Code Assist schema protocol rejects unknown fields,
including OpenCode/MCP numeric constraints such as `exclusiveMinimum` and
transport extensions such as `x-mcp-header`, before generating a response.

`src/providers/json-schema.ts` now projects tool schemas to a conservative wire
allowlist: `type`, `title`, `description`, `nullable`, string `enum`, `properties`,
`required`, `items`, `anyOf`, `propertyOrdering`, `default` and `example`.
Other validation constraints are preserved as description text; unsupported
metadata and transport extensions are omitted. Property maps are traversed
separately so arbitrary parameter names survive. Literal default/example values
are opaque data, including objects containing keyword-like names.

The projection handles nested items/properties, nullable types, multi-type
arrays, `anyOf`, `oneOf`, `allOf`, boolean subschemas and local references.
References support `$defs`, `definitions`, escaped JSON Pointer segments, array
indices and the root pointer. Reference siblings are intersected independently
of key order. Only own properties can be resolved. Recursion is bounded to 12
schema levels and 4096 expanded nodes, with a description at a truncated edge.
Shared subtrees are normalized at each occurrence.

Object `allOf` branches merge properties and union their required names; shared
properties intersect their representable constraints, including string enums.
Scalar type unions retain their alternatives and applicable type-specific
keywords. Null branches become `nullable`. Boolean true becomes an open object
schema; false becomes an explicit “no value is permitted” description. Impossible
branches are removed from unions before projection.

## Protocol limits

This is a compatibility projection, not a JSON Schema validator. Numeric bounds,
patterns, object-key validation, tuple positions, dependencies, conditionals and
other unsupported constraints reach the model as descriptions. They are not
hard validation at the provider. Non-string enum/const values are described
without coercing numbers, booleans or objects to strings. String constants use
single-value string enums.

`oneOf` alternatives use `anyOf` with an explicit exactly-one constraint in the
description. Intersections of independent unions keep one structural projection
and describe the other; they are never concatenated into a wider union or
arbitrarily reduced to one branch. Boolean false and null-only schemas require
description guidance where the protocol cannot express the exact restriction.
Unresolved/external/recursive references are described instead of fetched or
forwarded. Clients remain responsible for validating arguments before executing
their tools.

`src/providers/tools.ts` retains the same declaration group, parameter field,
tool choices and function-response mapping. No model routing, OAuth, streaming
or response-format behavior was changed. The shared local-pointer resolver now
also supports own-property checks, root pointers and array paths.

## Reference provenance

Inspected Oh My Pi's current default-branch revision via GitHub on 2026-10-24:
`0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0` (latest commit dated 2026-10-22).
The implementation follows its schema-slot classification, scalar type-array
normalization, string-enum wire restriction and description-spill approach.

- [Field classifications and unsupported Google keywords](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/ai/src/utils/schema/fields.ts)
- [Google/CCA normalization and boolean/nullable handling](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/ai/src/utils/schema/normalize.ts)
- [Description spill](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/ai/src/utils/schema/spill.ts)
- [Local dereferencing](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/ai/src/utils/schema/dereference.ts)
- [Google vs. CCA tool conversion](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/ai/src/providers/google-shared.ts)

OMP currently selects different parameter fields for Google and legacy CCA
Claude. This fix retains this gateway's existing `parameters` wire field and
served model, rather than changing routing or adopting a new request protocol.
The allowlist is deliberately stricter than OMP's denylist to cover future MCP
extensions without another unknown-field failure.

## Verification and deployment handoff

Regression fixtures in `tests/fixtures/tool-schemas.ts` are representative
OpenCode bash and REA `inspect_analysis_view` schemas, based on the exposed
source/view union shape, with additional MCP-emitter compatibility stress cases.
They are not captured user configuration or a claim to reproduce every REA
tool. Tests inspect schema positions independently from literal data and
property names. A fake upstream checks the actual serialized declarations and
a two-turn signed tool-call/result stream, without calling a live model.

Checks completed in this working tree:

- `npm test`: 290 tests passed across 32 test files.
- `npm run typecheck`: passed.
- `npm run build`: passed; compiled application and build metadata generated.
- `git diff --check`: passed.

No live upstream/OpenCode acceptance test was performed for this fix.

Local acceptance:

1. Start the updated gateway using `npm start` after the build, or `npm run dev`.
2. Use the existing OpenCode connection and enable the same REA/MCP tools that
   produced the rejection. Leave the OpenCode configuration as it is.
3. Repeat the failing prompt. Verify no schema-field HTTP 400 occurs, then test
   a read-only tool call and its follow-up result turn in the same session.
4. Check that arguments still have their intended types, particularly numeric
   timeouts/limits, nullable options and nested source/view objects.

The user authorized a GitHub push after this local handoff on 2026-10-24. The checked-in
Render blueprint has `autoDeploy: true`, so pushing a connected branch can
trigger deployment. No separate deployment command is part of the push. The
release includes the earlier reliability work, with the complete release diff
checked before committing. No schema migration or credential/configuration update is needed
for the tool-schema fix. Rollback uses the previous approved application
revision and the existing build/start commands.

## Oh My Pi license notice

MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

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
