# @qingshanjiluo/dsh-sql-formatter

Pure SQL formatter and analyzer for DeepSeek Harness. A hand-written keyword
lexer feeds a clause-aware pretty printer and a static analyser that reports
the relations, columns, and index candidates a script touches. No database, no
network, no subprocess, no listeners — every tool is a deterministic function of
its input, so the same script always formats and analyses the same way.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `sql_format` | `text`, `dialect?`, `indent?`, `uppercaseKeywords?` | Reformatted script, resolved dialect/indent, token and statement counts, lexer warnings |
| `sql_analyze` | `text`, `dialect?` | Statement kinds, physical tables, CTE names, qualified columns, joins with their conditions, predicates, `GROUP BY` / `ORDER BY` items, functions, subquery count, complexity score, advisories |
| `sql_index_suggestions` | `text`, `dialect?` | Composite B-tree candidates derived from `WHERE`, `JOIN`, `GROUP BY`, and `ORDER BY` columns, each with priority, reason, and ready-to-run `CREATE INDEX` DDL |

All three tools take SQL of any length, never reject a script, and degrade to
warnings when the input is malformed or an option is out of range.

## Install

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-sql-formatter
```

Register it in the profile's `cordis.patch.yml` (the host resolves the package
from the profile's `node_modules`; `pnpm-workspace.yaml` is not consulted):

```yaml
plugins:
  - '@qingshanjiluo/dsh-sql-formatter'
```

Mount it with the same top-level list format used for `dsh-commit-lint`:

```yaml
- insert:
    - id: sql-formatter
      name: '@qingshanjiluo/dsh-sql-formatter'
      config:
        dialect: standard
        indent: 2
        uppercaseKeywords: true
```

Then restart the host; `node scripts/load-smoke.mjs` checks the same contract
against the built artifact without a host.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dialect` | string | `standard` | Lexical dialect: `standard`, `mysql`, `postgresql`, `sqlite`, `transactsql`, `oracle`, or an alias of one. Unknown names fall back to `standard` with a warning. |
| `indent` | number | `2` | Spaces per indentation level; clamped to 1..8. |
| `uppercaseKeywords` | boolean | `true` | Keyword case. Identifiers, strings, and comments are always emitted verbatim. |

Per-call `dialect` / `indent` / `uppercaseKeywords` arguments override the
configuration for that call only.

## Formatting rules

- Clause keywords (`SELECT`, `FROM`, `WHERE`, `GROUP BY`, `SET`, `VALUES`, …)
  start a line; their operands sit on the following line, one indent deeper.
- Projection lists and multi-row `VALUES` break one item per line.
- `JOIN` families keep their keyword on one line, the condition follows, and
  consecutive `AND` / `OR` predicates align under it.
- Subqueries and CTE bodies open a block paren and indent the nested query.
- `BETWEEN x AND y` and quoted literals keep their shape; nothing inside a
  string, comment, or delimited identifier is ever rewritten.

```sql
-- in
select u.id, count(o.id) c from users u left join orders o on o.uid = u.id where u.active = 1 and total between 1 and 5 group by u.id

-- out
SELECT
  u.id,
  count(o.id) c
FROM
  users u
  LEFT JOIN orders o ON o.uid = u.id
WHERE
  u.active = 1
  AND total BETWEEN 1 AND 5
GROUP BY
  u.id
```

Only keywords change case. Function names and identifiers are emitted exactly as
written, so a user-defined `Total(x)` never becomes `TOTAL(x)`.

## Analysis and index hints

`sql_analyze` resolves aliases back to their tables (`users u` turns `u.id` into
`users.id`), reads through subqueries and derived tables, and separates physical
relations from common table expressions. It reports static risks that need no
catalog: an unguarded `UPDATE` / `DELETE`, `SELECT *`, a leading-wildcard `LIKE`,
an `IN (SELECT …)` that could be a semi-join, a comma-separated `FROM` list, and
clauses a dialect does not support (`LIMIT` under `transactsql`, `RETURNING`
under `mysql`).

`sql_index_suggestions` groups candidates per table with equality columns first,
then `IN` lists, then range and trailing `GROUP BY` / `ORDER BY` columns, capped
at four columns per index. It explains what it skipped: unqualified columns in a
multi-table statement, unknown relations, function-wrapped columns
(`YEAR(created_at) = 2020`), and non-sargable operators. CTE names are never
proposed, and `USING (col)` contributes a key on both sides of the join.

These are lexical heuristics from the script text alone — they say which columns
the query filters on, not which indexes already exist or which order is fastest.
Confirm with `EXPLAIN` on a real database before applying any DDL.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc + tsdown -> lib/index.js, lib/index.d.ts
npm test             # vitest run
node scripts/load-smoke.mjs   # mounts the built artifact and registers the tools
```

The plugin face is the Cordis function-plugin contract: named exports `name`,
`inject = ['tools']`, a schemastery `Config` schema, and `apply(ctx, config)`
which registers each tool through `ctx.tools.register(defineTool({ … }))`.

## License

MIT
