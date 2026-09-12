/**
 * Pure-SQL formatter and static analyzer for DeepSeek Harness.
 *
 * `sql_format` pretty-prints SQL with a hand-written keyword tokenizer and a
 * clause-aware emitter; `sql_analyze` reports the tables, columns, joins,
 * predicates, grouping, aggregates, and nesting a script touches;
 * `sql_index_suggestions` mines WHERE / JOIN / GROUP BY / ORDER BY usage into
 * composite index proposals with ready-to-run DDL.
 *
 * Everything is pure string in / JSON out: no database connection, no network,
 * no subprocess, no listener. The dialect only selects lexical rules and the
 * DDL flavor — these tools never run the SQL they are given.
 * @module @qingshanjiluo/dsh-sql-formatter
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-sql-formatter'
export const inject = ['tools']

/** Deployment defaults for the SQL tools. */
export interface Config {
  /** Default dialect: standard | mysql | postgresql | sqlite | transactsql | oracle. */
  dialect: string
  /** Spaces per indentation level for `sql_format`; clamped to 1..8. */
  indent: number
  /** Emit keywords upper-cased when true, lower-cased when false. */
  uppercaseKeywords: boolean
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  dialect: z.string().default('standard'),
  indent: z.number().default(2),
  uppercaseKeywords: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// Lexical layer
// ---------------------------------------------------------------------------

/** One lexical unit of a SQL script. */
interface Token {
  readonly kind: 'keyword' | 'ident' | 'qident' | 'string' | 'number' | 'operator' | 'punct' | 'param' | 'line_comment' | 'block_comment'
  /** Source text as written. */
  readonly value: string
  /** Identifier name without delimiters; the raw text for other kinds. */
  readonly name: string
  /** Upper-cased {@link value}; keyword comparisons use it. */
  readonly upper: string
}

/** Supported dialect identifiers. */
const DIALECTS = ['standard', 'mysql', 'postgresql', 'sqlite', 'transactsql', 'oracle'] as const
type Dialect = (typeof DIALECTS)[number]

const DIALECT_ALIASES: Record<string, Dialect> = {
  '': 'standard',
  ansi: 'standard',
  sql: 'standard',
  standard: 'standard',
  mariadb: 'mysql',
  maria: 'mysql',
  mysql: 'mysql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  psql: 'postgresql',
  pg: 'postgresql',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  mssql: 'transactsql',
  tsql: 'transactsql',
  transactsql: 'transactsql',
  sqlserver: 'transactsql',
  oracle: 'oracle',
  plsql: 'oracle',
  ora: 'oracle',
}

/** Reserved words, clause keywords, and the common type vocabulary. */
const KEYWORDS = new Set(`
SELECT FROM WHERE AND OR NOT IN BETWEEN LIKE ILIKE SIMILAR TO IS NULL TRUE FALSE UNKNOWN
INSERT INTO VALUES UPDATE SET DELETE MERGE MATCHED THEN USING
CREATE ALTER DROP TRUNCATE RENAME REPLACE ADD COLUMN MODIFY CHANGE
TABLE INDEX VIEW MATERIALIZED SCHEMA DATABASE SEQUENCE TRIGGER FUNCTION PROCEDURE
PRIMARY KEY FOREIGN REFERENCES UNIQUE CHECK DEFAULT CONSTRAINT AUTO_INCREMENT IDENTITY GENERATED ALWAYS AS
JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL STRAIGHT_JOIN ON
ORDER GROUP BY HAVING LIMIT OFFSET FETCH NEXT ROW ROWS ONLY UNION INTERSECT EXCEPT MINUS
DISTINCT ALL CASE WHEN THEN ELSE END EXISTS ANY SOME WITH RECURSIVE RETURNING
ASC DESC NULLS FIRST LAST TIES PERCENT ROLLUP CUBE ORDINALITY TABLESAMPLE
GRANT REVOKE COMMIT ROLLBACK BEGIN TRAN TRANSACTION SAVEPOINT RELEASE DECLARE
IF ELSEIF WHILE LOOP FOR EACH EXIT CONTINUE SIGNAL TEMPORARY TEMP GLOBAL LOCAL
CHAR CHARACTER VARCHAR VARCHAR2 NCHAR NVARCHAR NVARCHAR2 TEXT CLOB BLOB BINARY VARBINARY IMAGE
INT INTEGER SMALLINT TINYINT MEDIUMINT BIGINT DECIMAL DEC NUMERIC FLOAT DOUBLE PRECISION REAL
BOOLEAN BOOL BIT MONEY SERIAL BIGSERIAL SMALLSERIAL DATE DATETIME SMALLDATETIME TIME TIMESTAMP TIMESTAMPTZ YEAR JSON JSONB UUID XML ARRAY
CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER SESSION_USER SYSTEM_USER USER LOCALTIME LOCALTIMESTAMP SYSDATE SYSTIMESTAMP
CAST COALESCE NULLIF GREATEST LEAST INTERVAL OVER PARTITION RANGE PRECEDING FOLLOWING UNBOUNDED FILTER WITHIN EXCLUDE
SUBSTRING TRIM LEADING TRAILING BOTH POSITION EXTRACT EPOCH DAY MONTH HOUR MINUTE SECOND CONCAT NVL NVL2 DECODE LTRIM RTRIM TO_CHAR TO_DATE TO_NUMBER
CONNECT START PRIOR LEVEL ROWNUM DUAL LISTAGG SEPARATOR
COLLATE COLLATION DELAYED IGNORE HIGH_PRIORITY LOW_PRIORITY DUPLICATE CONFLICT DO NOTHING LATERAL
EXPLAIN ANALYZE QUERY PLAN VACUUM REINDEX SHOW DESCRIBE USE VERBOSE CONCURRENTLY
DATE_ADD DATE_SUB DATEDIFF DATE_TRUNC
`.trim().split(/\s+/))

/** Dialect-specific extras merged into {@link KEYWORDS}. */
const DIALECT_EXTRA: Record<Dialect, ReadonlySet<string>> = {
  standard: new Set(),
  mysql: new Set(['ENGINE', 'CHARSET', 'AUTO_INCREMENT', 'STRAIGHT_JOIN', 'DELAYED', 'GROUP_CONCAT', 'SEPARATOR']),
  postgresql: new Set(['ILIKE', 'LATERAL', 'RETURNING', 'CONCURRENTLY', 'MATERIALIZED', 'ARRAY', 'JSONB']),
  sqlite: new Set(['ABORT', 'RAISE', 'STRICT', 'WITHOUT', 'ROWID', 'CONFLICT']),
  transactsql: new Set(['NONCLUSTERED', 'CLUSTERED', 'IDENTITY', 'GO', 'TOP', 'OUTPUT', 'INSERTED', 'DELETED', 'TINYINT', 'MONEY']),
  oracle: new Set(['CONNECT', 'PRIOR', 'LEVEL', 'ROWNUM', 'DUAL', 'NVL', 'NVL2', 'DECODE', 'MINUS', 'LISTAGG']),
}

const WORD_START = /[A-Za-z_\u0080-\uFFFF]/
const WORD_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/
const DIGIT = /[0-9]/

/** Operators matched longest-first so `<=` never splits. */
const MULTI_OPERATORS = ['->>', '!~*', '~~*', '!~~*', '::', ':=', '||', '<=', '>=', '<>', '!=', '!~', '~~', '<<', '>>', '^@', '!<', '!>']

/** Strip the delimiters of a quoted identifier. */
function unquote(raw: string): string {
  if (raw.length < 2) return raw
  const first = raw[0]
  const last = raw[raw.length - 1]
  if ((first === '"' && last === '"') || (first === '`' && last === '`')) return raw.slice(1, -1).replace(/(""|``)/g, '$1')
  if (first === '[' && last === ']') return raw.slice(1, -1)
  return raw
}

function tok(kind: Token['kind'], value: string): Token {
  const name = kind === 'qident' ? unquote(value) : value
  return { kind, value, name, upper: value.toUpperCase() }
}

/** Whether `word` is reserved in `dialect`. */
function isKeyword(word: string, dialect: Dialect): boolean {
  const upper = word.toUpperCase()
  return KEYWORDS.has(upper) || DIALECT_EXTRA[dialect].has(upper)
}

/**
 * Split SQL into tokens. Whitespace is dropped (it carries no meaning for these
 * tools); lexical trouble — unterminated string, comment, or unbalanced
 * parenthesis — is reported as a warning instead of throwing.
 * @param sql - raw SQL script.
 * @param dialect - lexical dialect for keywords and quoting.
 * @returns tokens in source order plus warnings in discovery order.
 */
function tokenize(sql: string, dialect: Dialect): { tokens: Token[]; warnings: string[] } {
  const tokens: Token[] = []
  const warnings: string[] = []
  let i = 0
  let parenDepth = 0

  const push = (token: Token): void => {
    if (token.kind === 'punct' && token.value === '(') parenDepth++
    else if (token.kind === 'punct' && token.value === ')') parenDepth = Math.max(0, parenDepth - 1)
    tokens.push(token)
  }

  while (i < sql.length) {
    const ch = sql[i]!

    if (/\s/.test(ch)) {
      i++
      continue
    }

    // Line comments: `--` everywhere, `#` outside PostgreSQL / Oracle.
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '#' && dialect !== 'postgresql' && dialect !== 'oracle')) {
      const start = i
      while (i < sql.length && sql[i] !== '\n') i++
      push(tok('line_comment', sql.slice(start, i)))
      continue
    }

    // Nesting-aware block comment.
    if (ch === '/' && sql[i + 1] === '*') {
      const start = i
      let depth = 0
      while (i < sql.length) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
          continue
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2
          depth--
          if (depth === 0) break
          continue
        }
        i++
      }
      if (depth > 0) warnings.push(`unterminated block comment at offset ${start}`)
      push(tok('block_comment', sql.slice(start, i)))
      continue
    }

    // Single-quoted literal ('' doubling, backslash escapes on MySQL).
    if (ch === "'") {
      const start = i
      let out = "'"
      i++
      let closed = false
      while (i < sql.length) {
        const c = sql[i]!
        if (c === '\\' && dialect === 'mysql') {
          out += sql.slice(i, i + 2)
          i += 2
          continue
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            out += "''"
            i += 2
            continue
          }
          closed = true
          out += "'"
          i++
          break
        }
        out += c
        i++
      }
      if (!closed) warnings.push(`unterminated string literal at offset ${start}`)
      push(tok('string', out))
      continue
    }

    // Dollar-quoted string (PostgreSQL, Oracle, standard).
    if (ch === '$' && dialect !== 'mysql') {
      const match = /^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(sql.slice(i))
      if (match) {
        const tag = match[1]!
        const start = i
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) {
          warnings.push(`unterminated dollar-quoted string at offset ${start}`)
          i = sql.length
        } else {
          i = end + tag.length
        }
        push(tok('string', sql.slice(start, i)))
        continue
      }
    }

    // Delimited identifiers.
    if (ch === '"' || (ch === '`' && (dialect === 'mysql' || dialect === 'sqlite'))) {
      const quote = ch
      const start = i
      i++
      while (i < sql.length && sql[i] !== quote) i++
      if (i >= sql.length) warnings.push(`unterminated delimited identifier at offset ${start}`)
      else i++
      push(tok('qident', sql.slice(start, i)))
      continue
    }
    if (ch === '[' && (dialect === 'transactsql' || dialect === 'sqlite')) {
      const start = i
      const end = sql.indexOf(']', i)
      if (end === -1) warnings.push(`unterminated bracket identifier at offset ${start}`)
      i = end === -1 ? sql.length : end + 1
      push(tok('qident', sql.slice(start, i)))
      continue
    }

    // Numeric literal.
    if (DIGIT.test(ch) || (ch === '.' && sql[i + 1] !== undefined && DIGIT.test(sql[i + 1]!))) {
      const start = i
      if (ch === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        i += 2
        while (i < sql.length && /[0-9A-Fa-f]/.test(sql[i]!)) i++
        push(tok('number', sql.slice(start, i)))
        continue
      }
      while (i < sql.length && (DIGIT.test(sql[i]!) || sql[i] === '.' || sql[i] === '_')) i++
      if (i < sql.length && (sql[i] === 'e' || sql[i] === 'E')) {
        const sign = sql[i + 1]
        if (sign === '+' || sign === '-') i++
        while (i < sql.length && DIGIT.test(sql[i]!)) i++
      }
      push(tok('number', sql.slice(start, i)))
      continue
    }

    // Word: identifier or keyword.
    if (WORD_START.test(ch)) {
      const start = i
      while (i < sql.length && WORD_CHAR.test(sql[i]!)) i++
      const value = sql.slice(start, i)
      push(tok(isKeyword(value, dialect) ? 'keyword' : 'ident', value))
      continue
    }

    // Bind parameter: ?, :name, @name, @@name, $1.
    if (ch === '?') {
      push(tok('param', '?'))
      i++
      continue
    }
    if ((ch === ':' || ch === '@') && sql[i + 1] !== undefined && /[A-Za-z_@]/.test(sql[i + 1]!)) {
      const start = i
      i++
      if (sql[i] === '@') i++
      while (i < sql.length && WORD_CHAR.test(sql[i]!)) i++
      push(tok('param', sql.slice(start, i)))
      continue
    }
    if (ch === '$' && sql[i + 1] !== undefined && DIGIT.test(sql[i + 1]!)) {
      const start = i
      i++
      while (i < sql.length && DIGIT.test(sql[i]!)) i++
      push(tok('param', sql.slice(start, i)))
      continue
    }

    // Multi-character operator.
    let matched = false
    for (const op of MULTI_OPERATORS) {
      if (sql.startsWith(op, i)) {
        push(tok('operator', op))
        i += op.length
        matched = true
        break
      }
    }
    if (matched) continue

    // Punctuation.
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === '.') {
      push(tok('punct', ch))
      i++
      continue
    }

    if ('+-*/%<>=~^&|!'.includes(ch)) {
      push(tok('operator', ch))
      i++
      continue
    }

    // Anything else is preserved verbatim so formatting loses no text.
    push(tok('operator', ch))
    i++
  }

  if (parenDepth > 0) warnings.push(`${parenDepth} unclosed "(" at end of input`)
  return { tokens, warnings }
}

// ---------------------------------------------------------------------------
// Shared token helpers
// ---------------------------------------------------------------------------

/** Clause keywords the analyzer slices statements on. */
const ANALYZE_CLAUSES = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT',
  'MINUS', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'RETURNING', 'WITH', 'ON', 'USING', 'MATCHED', 'QUALIFY',
])

/** Clause keywords that start a fresh line when formatting. */
const FORMAT_CLAUSES = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT',
  'MINUS', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'RETURNING', 'WITH', 'QUALIFY',
])

/** Words that stay glued to the clause keyword that opened the line. */
const HEAD_KEYWORDS = new Set(['BY', 'ALL', 'DISTINCT', 'INTO', 'OUTER', 'KEY', 'RECURSIVE', 'TABLE', 'SCHEMA', 'THEN'])

/** Words that introduce a join and therefore start their own line. */
const JOIN_KEYWORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN'])

/** Clause keywords whose predicates are split on AND / OR. */
const PREDICATE_CLAUSES = new Set(['WHERE', 'HAVING', 'QUALIFY'])

/** Aggregate and window functions recognised by the analyzer. */
const AGGREGATE_FUNCTIONS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'LISTAGG', 'STDDEV', 'VARIANCE', 'ARRAY_AGG', 'JSON_AGG', 'BOOL_AND', 'BOOL_OR', 'EVERY', 'MEDIAN', 'PERCENTILE_CONT', 'PERCENTILE_DISC', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE'])

/** Whether `token` is a keyword with one of these upper-cased spellings. */
function isKw(token: Token | undefined, ...words: string[]): boolean {
  return token !== undefined && token.kind === 'keyword' && words.includes(token.upper)
}

/**
 * Index of the `)` closing the `(` at `open`.
 * @param tokens - token list to scan.
 * @param open - index of the opening parenthesis.
 * @returns matching index, or -1 when unbalanced.
 */
function matchingParen(tokens: readonly Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind !== 'punct') continue
    if (token.value === '(') depth++
    else if (token.value === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Whether a parenthesised group holds a query (and so formats as a block). */
function containsQuery(tokens: readonly Token[], from: number, to: number): boolean {
  const end = to === -1 ? tokens.length : to
  let depth = 0
  for (let i = from + 1; i < end; i++) {
    const token = tokens[i]!
    if (token.kind === 'punct' && token.value === '(') depth++
    else if (token.kind === 'punct' && token.value === ')') depth--
    else if (depth === 0 && isKw(token, 'SELECT', 'WITH')) return true
  }
  return false
}

/** Keywords after which an opening parenthesis keeps its space. */
const PAREN_SPACERS = new Set([...ANALYZE_CLAUSES, 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'IS', 'LIKE', 'ILIKE', 'SIMILAR', 'TO', 'AS', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'ANY', 'SOME', 'ALL', 'DISTINCT', 'VALUES', 'INTERVAL', 'OVER', 'FILTER', 'CASE', 'MATCHED', 'SET', 'WITH'])

/** Whether a `(` glues to the preceding token (function-call style). */
function glueParen(prev: Token | undefined): boolean {
  if (prev === undefined) return false
  if (prev.kind === 'ident' || prev.kind === 'qident') return true
  return prev.kind === 'keyword' && !PAREN_SPACERS.has(prev.upper)
}

/** Single-line rendering of a token slice with inline spacing rules. */
function renderRange(tokens: readonly Token[], from: number, to: number): string {
  let out = ''
  let prev: Token | undefined
  for (let i = Math.max(0, from); i < Math.min(to, tokens.length); i++) {
    const token = tokens[i]!
    if (token.kind === 'line_comment' || token.kind === 'block_comment') continue
    if (token.kind === 'punct' && (token.value === ',' || token.value === '.')) {
      out = `${out.trimEnd()}${token.value}`
      prev = token
      continue
    }
    if (token.kind === 'punct' && token.value === ')') {
      out = out.length === 0 ? ')' : `${out.trimEnd()})`
      prev = token
      continue
    }
    if (out.length === 0) {
      out = token.value
      prev = token
      continue
    }
    const glued = prev !== undefined && prev.kind === 'punct' && (prev.value === '.' || prev.value === '(')
    const tight = token.kind === 'punct' && token.value === '(' && glueParen(prev)
    out = glued || tight ? `${out}${token.value}` : `${out} ${token.value}`
    prev = token
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Collapse a dotted run starting at `i` into `a.b.c` and report the end index. */
function readDotted(tokens: readonly Token[], i: number): { text: string; end: number } {
  const parts: string[] = []
  let j = i
  let expectPart = true
  while (j < tokens.length) {
    const token = tokens[j]!
    if (expectPart && (token.kind === 'ident' || token.kind === 'qident')) {
      parts.push(token.name)
      expectPart = false
      j++
      continue
    }
    if (!expectPart && token.kind === 'punct' && token.value === '.' && j + 1 < tokens.length && (tokens[j + 1]!.kind === 'ident' || tokens[j + 1]!.kind === 'qident')) {
      expectPart = true
      j++
      continue
    }
    break
  }
  return { text: parts.join('.'), end: j }
}

/** Deduplicate preserving first-seen order. */
function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

/** Case-insensitive comparison used to stabilise emitted name lists. */
function compareCi(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b)
}

// ---------------------------------------------------------------------------
// Statement model
// ---------------------------------------------------------------------------

/** A parsed statement (or query block) and the relations it touches. */
interface Stmt {
  /** 1-based ordinal of the top-level statement this block belongs to. */
  index: number
  /** Leading statement keyword: SELECT, INSERT, UPDATE, DELETE, CREATE, … */
  kind: string
  tokens: Token[]
  /** Referenced table names in source order. */
  tables: string[]
  /** Lower-cased alias, table, or schema prefix → table display name. */
  alias: Map<string, string>
  /** Resolved `table.column` references (bare names when unresolvable). */
  columns: string[]
  /** Join clauses rendered with their ON condition. */
  joins: string[]
  /** Common table expression names defined by this block (never indexed). */
  ctes: string[]
  /** Structured join conditions used for index proposals. */
  joinParts: { label: string; kind: 'ON' | 'USING'; condition: string }[]
  /** Top-level WHERE / HAVING predicates. */
  predicates: string[]
  /** GROUP BY items. */
  groupBy: string[]
  /** ORDER BY items. */
  orderBy: string[]
  /** Aggregate and window functions used. */
  functions: string[]
  /** Commas at FROM-list level (implicit cross joins). */
  implicitJoins: number
  /** Nested query blocks (subqueries and CTE bodies). */
  children: Stmt[]
  /** Total nested query blocks below this one. */
  subqueries: number
  /** Advisory findings. */
  warnings: string[]
}

/** Clause keyword plus the token range it governs. */
interface Clause {
  name: string
  from: number
  to: number
}

/** Slice tokens into top-level clause ranges. */
function clauseRanges(tokens: readonly Token[]): Clause[] {
  const clauses: Clause[] = []
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'punct') {
      if (token.value === '(') depth++
      else if (token.value === ')') depth = Math.max(0, depth - 1)
      continue
    }
    if (token.kind !== 'keyword' || depth > 0) continue
    if (!ANALYZE_CLAUSES.has(token.upper)) continue
    if (token.upper === 'ON' && !isJoinOn(tokens, i)) continue
    clauses.push({ name: token.upper, from: i, to: tokens.length })
    if (clauses.length > 1) clauses[clauses.length - 2]!.to = i
  }
  return clauses
}

/** Whether the `ON` at `i` is a join predicate (not CREATE INDEX / PRIMARY KEY). */
function isJoinOn(tokens: readonly Token[], i: number): boolean {
  for (let j = i - 1; j >= 0 && j >= i - 10; j--) {
    const token = tokens[j]!
    if (token.kind === 'punct' && (token.value === '(' || token.value === ')')) return false
    if (isKw(token, 'USING', 'DUPLICATE')) return false
    if (token.kind === 'keyword') return !['PRIMARY', 'UNIQUE', 'KEY', 'CONSTRAINT', 'IF', 'NOT', 'EXISTS', 'INDEX', 'TABLE', 'VIEW', 'TRIGGER', 'FOREIGN'].includes(token.upper)
  }
  return false
}

/** Table reference discovered in FROM / JOIN / UPDATE / INTO position. */
interface TableRef {
  name: string
  alias: string
  joiner: string
  /** Condition text, without its `ON` / `USING` keyword. */
  on: string
  /** Which keyword introduced the condition. */
  onKind: '' | 'ON' | 'USING'
  /** Rendered label of the relation joined before this one (for USING lists). */
  peer: string
}

/** How a table reference reads in join descriptions. */
function labelOf(ref: TableRef): string {
  return ref.alias.length > 0 ? `${ref.name} AS ${ref.alias}` : ref.name
}

/**
 * Parse the table-reference list introduced by the keyword at `start`.
 * @param tokens - statement tokens.
 * @param start - index of FROM / JOIN / UPDATE / INTO / TABLE.
 * @param joiner - join label to attach (`''` for a FROM list).
 * @returns parsed references and the index parsing stopped at.
 */
function parseTableRefs(tokens: readonly Token[], start: number, joiner: string): { refs: TableRef[]; end: number; commas: number } {
  const refs: TableRef[] = []
  const family: string[] = joiner ? [joiner] : []
  let i = start + 1
  let depth = 0
  let commas = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.kind === 'punct') {
      if (token.value === '(' && depth === 0 && refs.length === 0) {
        const close = matchingParen(tokens, i)
        const inner = tokens.slice(i + 1, close === -1 ? tokens.length : close)
        for (const ref of collectTables(inner)) if (!refs.some(r => r.name === ref.name)) refs.push({ ...ref, joiner: 'DERIVED', on: '', onKind: '', peer: '' })
        i = close === -1 ? tokens.length : close + 1
        // `FROM (SELECT …) AS x` names the derived set; it is not a new table.
        if (isKw(tokens[i], 'AS')) i++
        const aliasToken = tokens[i]
        const last = refs[refs.length - 1]
        if (aliasToken !== undefined && (aliasToken.kind === 'ident' || aliasToken.kind === 'qident') && last !== undefined) {
          refs[refs.length - 1] = { ...last, alias: aliasToken.name }
          i++
        }
        continue
      }
      if (token.value === '(') depth++
      else if (token.value === ')') {
        if (depth === 0) break
        depth--
      } else if (token.value === ',' && depth === 0) {
        commas++
        family.length = 0
      }
      i++
      continue
    }
    if (token.kind === 'keyword' && depth === 0) {
      if (JOIN_KEYWORDS.has(token.upper)) {
        family.push(token.upper)
        i++
        continue
      }
      if (isKw(token, 'AS')) {
        i++
        continue
      }
      if (isKw(token, 'ON', 'USING') && refs.length > 0) {
        const close = scanToClauseEnd(tokens, i + 1)
        const current = refs[refs.length - 1]!
        const raw = renderRange(tokens, i + 1, close)
        const condition = token.upper === 'USING' ? raw.replace(/^\((.*)\)$/s, '$1') : raw
        const peer = refs.length > 1 ? labelOf(refs[refs.length - 2]!) : ''
        refs[refs.length - 1] = { ...current, on: condition, onKind: token.upper === 'ON' ? 'ON' : 'USING', peer }
        i = close
        continue
      }
      if (ANALYZE_CLAUSES.has(token.upper)) break
      i++
      continue
    }
    if ((token.kind === 'ident' || token.kind === 'qident') && depth === 0) {
      const dotted = readDotted(tokens, i)
      let j = dotted.end
      if (isKw(tokens[j], 'AS')) j++
      let alias = ''
      const candidate = tokens[j]
      if (candidate !== undefined && (candidate.kind === 'ident' || candidate.kind === 'qident') && !looksOperand(tokens, j) && (candidate.upper !== dotted.text.toUpperCase() || candidate.kind === 'qident')) {
        alias = candidate.name
        j++
      }
      if (tokens[j]?.kind === 'punct' && tokens[j]?.value === '(') j = (matchingParen(tokens, j) + 1 || j + 1)
      const label = (family.length > 0 ? family.join(' ') : joiner).trim()
      if (!refs.some(r => r.name === dotted.text)) refs.push({ name: dotted.text, alias, joiner: label, on: '', onKind: '', peer: '' })
      family.length = 0
      i = j
      continue
    }
    i++
  }
  return { refs, end: i, commas }
}

/** Whether the identifier at `i` reads as an operand (comparison) not an alias. */
function looksOperand(tokens: readonly Token[], i: number): boolean {
  const next = tokens[i + 1]
  if (next === undefined) return false
  if (next.kind === 'operator') return true
  return next.kind === 'keyword' && ['IN', 'LIKE', 'ILIKE', 'BETWEEN', 'IS'].includes(next.upper)
}

/** End index of the clause opened at `from` (next top-level clause keyword). */
function scanToClauseEnd(tokens: readonly Token[], from: number): number {
  let depth = 0
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'punct') {
      if (token.value === '(') depth++
      else if (token.value === ')') {
        if (depth === 0) return i
        depth--
      }
      continue
    }
    if (token.kind === 'keyword' && depth === 0 && ANALYZE_CLAUSES.has(token.upper) && !isKw(token, 'ON', 'USING', 'AND', 'OR')) return i
  }
  return tokens.length
}

/**
 * Tables a token list reads from, used for derived-table bodies.
 * @param tokens - tokens inside the parentheses.
 * @returns references with their aliases, from FROM / JOIN heads only.
 */
function collectTables(tokens: readonly Token[]): TableRef[] {
  const refs: TableRef[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!isKw(token, 'FROM', 'JOIN', 'INTO', 'UPDATE')) continue
    if (isKw(tokens[i - 1], 'CREATE', 'DROP', 'ALTER', 'TRUNCATE')) continue
    const { refs: found, end } = parseTableRefs(tokens, i, token.upper === 'JOIN' ? 'JOIN' : '')
    for (const ref of found) if (!refs.some(r => r.name === ref.name)) refs.push(ref)
    i = Math.max(i, end - 1)
  }
  return refs
}

/** Direct DML target table (UPDATE t / DELETE FROM t / INSERT INTO t). */
function tableTarget(tokens: readonly Token[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    if (!isKw(tokens[i], 'UPDATE', 'DELETE', 'INSERT', 'MERGE', 'TRUNCATE')) continue
    for (let j = i + 1; j < Math.min(i + 5, tokens.length); j++) {
      const token = tokens[j]!
      if (token.kind === 'keyword' && isKw(token, 'FROM', 'INTO', 'TABLE', 'OR', 'IGNORE')) continue
      if (token.kind === 'keyword' && isKw(token, 'SET', 'VALUES', 'WHERE', 'USING', 'SELECT')) break
      if (token.kind === 'ident' || token.kind === 'qident') return readDotted(tokens, j).text
    }
  }
  return undefined
}

/** Record a bare column, qualified with the only table when there is one. */
function addColumn(stmt: Stmt, name: string): void {
  const lowered = name.toLowerCase()
  if (stmt.alias.has(lowered)) return
  if (stmt.tables.length === 1) {
    const table = stmt.tables[0]!
    if (table.toLowerCase().split('.').pop() === lowered) return
    stmt.columns.push(`${table}.${name}`)
    return
  }
  stmt.columns.push(name)
}

/**
 * Collect `WITH name AS (SELECT …)` definitions, including those inside nested
 * blocks, so the analyzer can tell virtual relations from physical tables.
 * @param tokens - statement tokens.
 * @param into - set collecting the defined names.
 */
function collectCteNames(tokens: readonly Token[], into: Set<string>): void {
  for (let i = 1; i < tokens.length; i++) {
    if (!isKw(tokens[i], 'AS')) continue
    const name = tokens[i - 1]!
    const next = tokens[i + 1]
    if ((name.kind === 'ident' || name.kind === 'qident') && next?.kind === 'punct' && next.value === '(' && containsQuery(tokens, i + 1, matchingParen(tokens, i + 1))) {
      into.add(name.name)
    }
  }
}

/**
 * Verb a statement actually executes: `WITH … SELECT …` is a SELECT.
 * @param tokens - statement tokens.
 * @returns upper-case kind.
 */
function statementKind(tokens: readonly Token[]): string {
  const first = tokens.find(t => t.kind === 'keyword')
  let kind = first?.upper ?? (tokens.length === 0 ? 'EMPTY' : 'UNKNOWN')
  if (kind !== 'WITH') return kind
  let depth = 0
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.value === '(') depth++
      else if (token.value === ')') depth = Math.max(0, depth - 1)
      continue
    }
    if (token.kind === 'keyword' && depth === 0 && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(token.upper)) return token.upper
  }
  return kind
}

/**
 * Build the statement model used by analysis and index suggestions.
 * @param index - 1-based statement ordinal.
 * @param tokens - block tokens (no top-level `;`).
 * @param dialect - resolved lexical dialect.
 * @param cteNames - CTE names defined by the owning statement.
 * @returns the populated statement, including nested query blocks.
 */
function parseStatement(index: number, tokens: Token[], dialect: Dialect, cteNames: ReadonlySet<string> = new Set()): Stmt {
  const stmt: Stmt = {
    index,
    kind: statementKind(tokens),
    tokens,
    tables: [],
    alias: new Map(),
    columns: [],
    joins: [],
    joinParts: [],
    ctes: [],
    predicates: [],
    groupBy: [],
    orderBy: [],
    functions: [],
    implicitJoins: 0,
    children: [],
    subqueries: 0,
    warnings: [],
  }

  // Nested query blocks (subqueries and CTE bodies).
  let blockDepth = 0
  const blocks: [number, number][] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind !== 'punct') continue
    if (token.value === '(') {
      if (blockDepth === 0 && containsQuery(tokens, i, matchingParen(tokens, i))) blocks.push([i, matchingParen(tokens, i)])
      blockDepth++
    } else if (token.value === ')') blockDepth = Math.max(0, blockDepth - 1)
  }
  for (const [open, close] of blocks) {
    if (close === -1) continue
    stmt.children.push(parseStatement(index, tokens.slice(open + 1, close), dialect, cteNames))
  }
  stmt.subqueries = stmt.children.reduce((sum, child) => sum + 1 + child.subqueries, 0)

  // Relations from clause heads and join keywords.
  const clauses = clauseRanges(tokens)
  const register = (ref: TableRef): void => {
    const target = labelOf(ref)
    const addPart = (kind: 'ON' | 'USING', condition: string, label: string): void => {
      if (condition.length === 0) return
      if (stmt.joinParts.some(part => part.label === label && part.kind === kind && part.condition === condition)) return
      stmt.joinParts.push({ label, kind, condition })
    }
    const virtual = cteNames.has(ref.name) || cteNames.has(ref.name.split('.').pop()!)
    if (virtual) {
      // A common table expression is not a physical relation: keep its alias
      // for column qualification but never propose indexes on it.
      if (!stmt.ctes.includes(ref.name)) stmt.ctes.push(ref.name)
      stmt.alias.set(ref.name.toLowerCase(), ref.name)
      if (ref.alias.length > 0) stmt.alias.set(ref.alias.toLowerCase(), ref.name)
      addPart(ref.onKind === 'USING' ? 'USING' : 'ON', ref.on, target)
      return
    }
    if (!stmt.tables.includes(ref.name)) stmt.tables.push(ref.name)
    stmt.alias.set(ref.name.toLowerCase(), ref.name)
    stmt.alias.set(ref.name.split('.').pop()!.toLowerCase(), ref.name)
    if (ref.alias.length > 0) stmt.alias.set(ref.alias.toLowerCase(), ref.name)
    if (ref.joiner.length > 0 && ref.joiner !== 'FROM' && ref.joiner !== 'DERIVED') {
      const condition = ref.on.length > 0 ? ` ${ref.onKind} ${ref.on}` : ''
      stmt.joins.push(`${ref.joiner.replace(/\s+/g, ' ').trim()} ${target}${condition}`)
      const kind = ref.onKind === 'USING' ? 'USING' : 'ON'
      addPart(kind, ref.on, target)
      // A USING list names a column on both sides of the join.
      if (kind === 'USING' && ref.peer.length > 0) addPart('USING', ref.on, ref.peer)
    }
  }
  for (const clause of clauses) {
    if (!['FROM', 'INTO', 'UPDATE', 'TABLE'].includes(clause.name)) continue
    if (isKw(tokens[clause.from - 1], 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME')) continue
    const parsed = parseTableRefs(tokens, clause.from, '')
    if (clause.name === 'FROM') stmt.implicitJoins += parsed.commas
    for (const ref of parsed.refs) register(ref)
  }
  let walkDepth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'punct') {
      if (token.value === '(') walkDepth++
      else if (token.value === ')') walkDepth = Math.max(0, walkDepth - 1)
      continue
    }
    if (token.kind !== 'keyword' || walkDepth > 0) continue
    if (!JOIN_KEYWORDS.has(token.upper)) continue
    if (token.upper !== 'JOIN') continue
    for (const ref of parseTableRefs(tokens, i, '').refs) register(ref)
  }
  if (stmt.tables.length === 0 && ['UPDATE', 'DELETE', 'INSERT', 'MERGE'].includes(stmt.kind)) {
    const target = tableTarget(tokens)
    if (target !== undefined) register({ name: target, alias: '', joiner: '', on: '', onKind: '', peer: '' })
  }

  // Columns and functions: every depth except the nested query blocks, which
  // the child statements report for themselves.
  const inQueryBlock = new Uint8Array(tokens.length)
  for (const [open, close] of blocks) {
    if (close === -1) continue
    for (let i = open; i <= close && i < tokens.length; i++) inQueryBlock[i] = 1
  }
  for (let i = 0; i < tokens.length; i++) {
    if (inQueryBlock[i] === 1) continue
    const token = tokens[i]!
    if (token.kind === 'punct') continue
    if (token.kind === 'operator' && token.value === '*') {
      if (isKw(tokens[i - 1], 'SELECT') || isKw(tokens[i - 2], 'SELECT')) {
        stmt.warnings.push('SELECT * reads every column — name the columns you need')
      } else if (tokens[i - 1]?.kind === 'punct' && tokens[i - 1]?.value === '.') {
        const qualifier = tokens[i - 2]?.name ?? '*'
        stmt.warnings.push(`${qualifier}.* widens the projection`)
      }
      continue
    }
    if (token.kind === 'keyword') {
      if ((AGGREGATE_FUNCTIONS.has(token.upper) || isKw(token, 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX')) && tokens[i + 1]?.value === '(') {
        if (!stmt.functions.includes(token.upper)) stmt.functions.push(token.upper)
      }
      continue
    }
    if (token.kind !== 'ident' && token.kind !== 'qident') continue
    if (tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '(') {
      const fn = token.name.toUpperCase()
      if (AGGREGATE_FUNCTIONS.has(fn) && !stmt.functions.includes(fn)) stmt.functions.push(fn)
      continue
    }
    if (tokens[i - 1]?.kind === 'punct' && (tokens[i - 1]?.value === '.' || tokens[i - 1]?.value === '(')) continue
    if (isKw(tokens[i - 1], 'AS')) continue
    if (tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '.') {
      const dotted = readDotted(tokens, i)
      const parts = dotted.text.split('.')
      const namedTable = stmt.tables.some(t => t.toLowerCase() === dotted.text.toLowerCase()) || stmt.ctes.some(c => c.toLowerCase() === dotted.text.toLowerCase())
      if (parts.length >= 2 && !namedTable) {
        const column = parts[parts.length - 1]!
        const qualifier = parts[parts.length - 2]!
        const table = stmt.alias.get(qualifier.toLowerCase())
        stmt.columns.push(`${table ?? qualifier}.${column}`)
      }
      i = Math.max(i, dotted.end - 1)
      continue
    }
    addColumn(stmt, token.name)
  }

  // Predicates, grouping, and ordering from this block's clauses.
  for (const clause of clauses) {
    if (PREDICATE_CLAUSES.has(clause.name)) {
      for (const [from, to] of splitOnConjunctions(tokens, clause.from + 1, clause.to)) {
        const text = renderRange(tokens, from, to)
        if (text.length > 0) stmt.predicates.push(text)
      }
    }
    if (clause.name === 'GROUP' || clause.name === 'ORDER') {
      const target = clause.name === 'GROUP' ? stmt.groupBy : stmt.orderBy
      const body = isKw(tokens[clause.from + 1], 'BY') ? clause.from + 2 : clause.from + 1
      for (const [from, to] of splitTopLevel(tokens, body, clause.to)) {
        const text = renderRange(tokens, from, to)
        if (text.length > 0) target.push(text)
      }
    }
  }

  stmt.warnings.push(...statementAdvice(stmt, dialect))
  stmt.columns = unique(stmt.columns).sort(compareCi)
  stmt.tables = unique(stmt.tables)
  stmt.joins = unique(stmt.joins)
  stmt.predicates = unique(stmt.predicates)
  return stmt
}

/** Split a token range on top-level AND / OR. */
function splitOnConjunctions(tokens: readonly Token[], from: number, to: number): [number, number][] {
  const pieces: [number, number][] = []
  let depth = 0
  let start = from
  for (let i = from; i < to; i++) {
    const token = tokens[i]!
    if (token.kind === 'punct') {
      if (token.value === '(') depth++
      else if (token.value === ')') depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && isKw(token, 'AND', 'OR')) {
      pieces.push([start, i])
      start = i + 1
    }
  }
  pieces.push([start, to])
  return pieces.filter(([a, b]) => renderRange(tokens, a, b).length > 0)
}

/** Split a token range on top-level commas. */
function splitTopLevel(tokens: readonly Token[], from: number, to: number): [number, number][] {
  const pieces: [number, number][] = []
  let depth = 0
  let start = from
  for (let i = from; i < to; i++) {
    const token = tokens[i]!
    if (token.kind !== 'punct') continue
    if (token.value === '(') depth++
    else if (token.value === ')') depth = Math.max(0, depth - 1)
    else if (token.value === ',' && depth === 0) {
      pieces.push([start, i])
      start = i + 1
    }
  }
  pieces.push([start, to])
  return pieces.filter(([a, b]) => renderRange(tokens, a, b).length > 0)
}

/** Static advisories that need no database to evaluate. */
function statementAdvice(stmt: Stmt, dialect: Dialect): string[] {
  const found: string[] = []
  const flat = stmt.tokens.map(t => t.upper).join(' ')
  if ((stmt.kind === 'UPDATE' || stmt.kind === 'DELETE') && !/\bWHERE\b/.test(flat)) {
    found.push(`statement ${stmt.index}: ${stmt.kind} has no WHERE clause and rewrites the whole table`)
  }
  if (/\bLIKE\s+'%/.test(flat)) found.push(`statement ${stmt.index}: a LIKE pattern begins with % and cannot seek a B-tree index`)
  if (stmt.joins.length > 0 && stmt.joins.some(join => !/\b(ON|USING)\b/.test(join) && !/^(NATURAL|CROSS)\b/.test(join))) {
    found.push(`statement ${stmt.index}: a join has no ON predicate — confirm the cartesian product is intended`)
  }
  if (stmt.implicitJoins > 0) {
    found.push(`statement ${stmt.index}: ${stmt.implicitJoins + 1} comma-separated relations in FROM — an implicit cross join unless joined in WHERE`)
  }
  if (/\bIN\s+\(\s*SELECT\b/.test(flat)) found.push(`statement ${stmt.index}: IN (SELECT …) — consider EXISTS or a semi-join`)
  if (/\bLIMIT\b/.test(flat) && (dialect === 'transactsql' || dialect === 'oracle')) {
    found.push(`statement ${stmt.index}: LIMIT is not valid in ${dialect} — use TOP or FETCH FIRST n ROWS ONLY`)
  }
  if (/\bRETURNING\b/.test(flat) && dialect === 'mysql') {
    found.push(`statement ${stmt.index}: MySQL has no RETURNING clause — re-query the affected rows`)
  }
  return found
}

/** Pre-order walk of statements and their nested query blocks. */
function flatten(statements: readonly Stmt[]): Stmt[] {
  const out: Stmt[] = []
  const visit = (stmt: Stmt): void => {
    out.push(stmt)
    for (const child of stmt.children) visit(child)
  }
  for (const stmt of statements) visit(stmt)
  return out
}

/** Split a token list into statements on top-level semicolons. */
function splitStatements(tokens: readonly Token[]): Token[][] {
  const statements: Token[][] = []
  let current: Token[] = []
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ';') {
      if (current.length > 0) statements.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) statements.push(current)
  return statements.filter(group => group.some(t => t.kind !== 'line_comment' && t.kind !== 'block_comment'))
}

/** Aggregated shape returned by `sql_analyze`. */
interface Analysis {
  statementCount: number
  statementKinds: string[]
  tables: string[]
  ctes: string[]
  columns: string[]
  joins: string[]
  predicates: string[]
  groupBy: string[]
  orderBy: string[]
  functions: string[]
  subqueries: number
  complexity: number
  warnings: string[]
}

/**
 * Extract relations, columns, predicates, and complexity from a script.
 * @param sql - raw SQL script.
 * @param dialect - resolved lexical dialect.
 * @returns aggregated analysis, the statement models, and lexer warnings.
 */
function analyzeSql(sql: string, dialect: Dialect): { analysis: Analysis; statements: Stmt[]; warnings: string[] } {
  const { tokens, warnings } = tokenize(sql.replace(/\r\n?/g, '\n'), dialect)
  const groups = splitStatements(tokens)
  const statements = groups.map((group, i) => {
    const defined = new Set<string>()
    collectCteNames(group, defined)
    const stmt = parseStatement(i + 1, group, dialect, defined)
    stmt.ctes = unique([...stmt.ctes, ...defined])
    return stmt
  })
  const all = flatten(statements)
  const analysis: Analysis = {
    statementCount: statements.length,
    statementKinds: statements.map(s => `${s.index} ${s.kind}`),
    tables: unique(all.flatMap(s => s.tables)).sort(compareCi),
    ctes: unique(all.flatMap(s => s.ctes)).sort(compareCi),
    columns: unique(all.flatMap(s => s.columns)).sort(compareCi),
    joins: unique(all.flatMap(s => s.joins)),
    predicates: unique(all.flatMap(s => s.predicates)),
    groupBy: unique(all.flatMap(s => s.groupBy)),
    orderBy: unique(all.flatMap(s => s.orderBy)),
    functions: unique(all.flatMap(s => s.functions)).sort(compareCi),
    subqueries: statements.reduce((sum, s) => sum + s.subqueries, 0),
    complexity: all.reduce((sum, s) => sum + s.tables.length + s.joins.length * 2 + s.predicates.length + s.groupBy.length + s.orderBy.length + s.functions.length + s.subqueries, 0),
    warnings: unique(all.flatMap(s => s.warnings)),
  }
  return { analysis, statements, warnings }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Resolved formatting options for one call. */
interface FormatOptions {
  indent: number
  uppercaseKeywords: boolean
  dialect: Dialect
}

/** Leading whitespace of a partially built line. */
function lineIndent(line: string): string {
  return /^[ ]*/.exec(line)?.[0] ?? ''
}

/**
 * Pretty-print a SQL script: clause keywords start lines, projections and
 * multi-row VALUES list one item per line, joins and subqueries indent,
 * literals and comments keep their exact source text.
 * @param sql - raw script (one or more statements).
 * @param options - indentation width, keyword case, lexical dialect.
 * @returns formatted text, token count, statement count, and warnings.
 */
function formatSql(sql: string, options: FormatOptions): { formatted: string; tokenCount: number; statementCount: number; warnings: string[] } {
  const source = sql.replace(/\r\n?/g, '\n')
  const { tokens, warnings } = tokenize(source, options.dialect)
  if (tokens.length === 0) return { formatted: '', tokenCount: 0, statementCount: 0, warnings }

  const unit = ' '.repeat(Math.min(8, Math.max(1, Math.trunc(options.indent))))
  const lines: string[] = []
  let current = ''
  let base = ''
  let cont = unit
  let predicate = unit
  let pending: string | null = null
  let betweenOpen = false
  let glueNext = false
  let rowCount = 0
  let lastClause = ''
  let tablePosition = false
  let justTable = false
  const frames: { block: boolean; base: string; cont: string; predicate: string; outer: string }[] = []

  const flush = (): void => {
    const trimmed = current.trimEnd()
    if (trimmed.trim().length > 0) lines.push(trimmed)
    current = ''
  }
  const breakTo = (indentText: string): void => {
    flush()
    current = indentText
    pending = null
    glueNext = false
  }
  const append = (value: string, glue = false): void => {
    const tight = glue || glueNext
    glueNext = false
    if (current.length === 0) {
      current = value
      return
    }
    if (tight) {
      // Butt the value against the previous token without eating indentation.
      current = /^\s*$/.test(current) ? `${current}${value}` : `${current.trimEnd()}${value}`
      return
    }
    current = /[\s(]$/.test(current) ? `${current}${value}` : `${current} ${value}`
  }
  const word = (token: Token): string => (options.uppercaseKeywords ? token.upper : token.value.toLowerCase())
  const topIsInline = (): boolean => frames.length > 0 && !frames[frames.length - 1]!.block

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!

    if (token.kind === 'line_comment') {
      // Comments sit on their own line at the indent the next token would use.
      const at: string = pending ?? (current.trim() === '' ? current : lineIndent(current))
      flush()
      current = at
      append(token.value)
      flush()
      pending = at
      continue
    }
    if (token.kind === 'block_comment') {
      if (pending !== null) breakTo(pending)
      append(token.value)
      continue
    }

    if (token.kind === 'punct' && token.value === '(') {
      const close = matchingParen(tokens, i)
      const block = close !== -1 && containsQuery(tokens, i, close)
      if (pending !== null) breakTo(pending)
      // The closing parenthesis aligns with this line's indentation.
      const outer = lineIndent(current)
      const glue = glueParen(tokens[i - 1]) && !justTable
      frames.push({ block, base, cont, predicate, outer })
      append('(', glue)
      if (block) {
        base = `${outer}${unit}`
        cont = `${base}${unit}`
        predicate = cont
        pending = base
      }
      justTable = false
      continue
    }

    if (token.kind === 'punct' && token.value === ')') {
      const frame = frames.pop()
      if (frame === undefined) {
        warnings.push('unexpected ")" without a matching "("')
        append(')', true)
        continue
      }
      if (frame.block) breakTo(frame.outer)
      else if (pending !== null) breakTo(pending)
      append(')', true)
      base = frame.base
      cont = frame.cont
      predicate = frame.predicate
      pending = null
      justTable = false
      continue
    }

    if (token.kind === 'punct' && token.value === ',') {
      if (pending !== null) breakTo(pending)
      append(',', true)
      if (!topIsInline()) {
        breakTo(cont)
        tablePosition = lastClause === 'FROM'
      } else {
        current = `${current.trimEnd()} `
      }
      continue
    }

    if (token.kind === 'punct' && token.value === ';') {
      if (pending !== null) breakTo(pending)
      append(';', true)
      flush()
      rowCount++
      if (i + 1 < tokens.length) {
        lines.push('')
        base = ''
        cont = unit
        predicate = unit
        pending = null
        lastClause = ''
        tablePosition = false
        justTable = false
        frames.length = 0
      }
      continue
    }

    if (token.kind === 'punct' && token.value === '.') {
      append('.', true)
      glueNext = true
      continue
    }

    if (token.kind === 'keyword' && JOIN_KEYWORDS.has(token.upper) && !topIsInline()) {
      const family: string[] = []
      let j = i
      while (j < tokens.length && tokens[j]!.kind === 'keyword' && JOIN_KEYWORDS.has(tokens[j]!.upper)) {
        family.push(word(tokens[j]!))
        j++
      }
      breakTo(`${base}${unit}`)
      append(family.join(' '))
      cont = `${base}${unit}`
      predicate = `${base}${unit}${unit}`
      pending = null
      lastClause = 'FROM'
      tablePosition = true
      i = j - 1
      continue
    }

    if (token.kind === 'keyword' && FORMAT_CLAUSES.has(token.upper) && !topIsInline()) {
      breakTo(base)
      append(word(token))
      cont = `${base}${unit}`
      predicate = cont
      pending = cont
      lastClause = token.upper
      tablePosition = token.upper === 'FROM' || token.upper === 'INTO' || token.upper === 'UPDATE' || token.upper === 'WITH'
      betweenOpen = false
      continue
    }

    if (token.kind === 'keyword' && (token.upper === 'AND' || token.upper === 'OR')) {
      if (betweenOpen) {
        // The AND that closes BETWEEN … AND … stays on the line.
        betweenOpen = false
      } else if (!topIsInline()) {
        breakTo(pending ?? predicate)
        append(word(token))
        continue
      }
    } else if (token.kind === 'keyword' && token.upper === 'BETWEEN') {
      betweenOpen = true
    }

    if (token.kind === 'keyword' && HEAD_KEYWORDS.has(token.upper)) {
      if (isKw(token, 'INTO', 'TABLE', 'VIEW', 'INDEX')) tablePosition = true
      append(word(token))
      continue
    }

    if (pending !== null) breakTo(pending)
    if (token.kind === 'ident' || token.kind === 'qident') {
      if (tablePosition) {
        justTable = true
        tablePosition = false
      } else {
        justTable = false
      }
    } else if (token.kind !== 'punct' || !(token.value === '(')) {
      justTable = false
    }
    append(token.kind === 'keyword' ? word(token) : token.value)
  }

  flush()
  const formatted = lines
    .join('\n')
    .split('\n')
    .map(line => line.trimEnd())
    .filter((line, idx, all) => !(line.length === 0 && (idx === 0 || idx === all.length - 1 || all[idx - 1] === '')))
    .join('\n')
    .trim()

  const statementCount = rowCount > 0 ? rowCount : sql.trim().length === 0 ? 0 : 1
  return { formatted, tokenCount: tokens.length, statementCount, warnings }
}

// ---------------------------------------------------------------------------
// Index suggestions
// ---------------------------------------------------------------------------

/** One composite index proposal. */
interface Suggestion {
  table: string
  columns: string[]
  kind: string
  reason: string
  priority: string
  ddl: string
}

/** Candidate column plus its selectivity class. */
interface Predicate {
  column: string
  shape: 'equality' | 'set' | 'range' | 'prefix' | 'other'
  /** Right-hand side when it is itself a qualified column (an old-style join). */
  peer?: string
}

/** Bucket of candidate columns for one table. */
interface Bucket {
  table: string
  equality: string[]
  set: string[]
  range: string[]
  trailing: string[]
  reasons: Set<string>
  priority: number
}

const PRIORITY_LABELS = ['', 'high', 'medium', 'low'] as const

/** CREATE INDEX text in the requested dialect. */
function indexDdl(dialect: Dialect, indexName: string, table: string, columns: readonly string[]): string {
  const list = columns.join(', ')
  if (dialect === 'postgresql') return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING btree (${list});`
  if (dialect === 'sqlite') return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${list});`
  if (dialect === 'transactsql') return `CREATE NONCLUSTERED INDEX ${indexName} ON ${table} (${list});`
  return `CREATE INDEX ${indexName} ON ${table} (${list});`
}

/** First column-looking token of a GROUP BY / ORDER BY item. */
function firstColumn(item: string): string {
  const cleaned = stripQuotes(item.trim())
  return /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(cleaned)?.[1] ?? cleaned
}

/** Remove surrounding quotes and brackets from a column reference. */
function stripQuotes(value: string): string {
  return value.replace(/["`[\]]/g, '').trim()
}

/**
 * Classify `column op value` and report the leading column plus how selective
 * the operator is for an index probe.
 * @param predicate - normalised predicate text.
 * @returns column and shape, or undefined when the text has no leading column.
 */
function parsePredicate(predicate: string): Predicate | undefined {
  const text = predicate.trim()
  if (text.length === 0) return undefined
  const negated = /^NOT\s+(.+)$/is.exec(text)
  if (negated) return parsePredicate(negated[1]!)
  const isNull = /^("?[A-Za-z_$][\w$.]*"?)\s+IS\s+(NOT\s+)?NULL$/i.exec(text)
  if (isNull) return { column: stripQuotes(isNull[1]!), shape: isNull[2] ? 'other' : 'equality' }
  const inList = /^("?[A-Za-z_$][\w$.]*"?)\s+(NOT\s+)?IN\s*\(/i.exec(text)
  if (inList) return { column: stripQuotes(inList[1]!), shape: inList[2] ? 'other' : 'set' }
  const between = /^("?[A-Za-z_$][\w$.]*"?)\s+(NOT\s+)?BETWEEN\s+/i.exec(text)
  if (between) return { column: stripQuotes(between[1]!), shape: between[2] ? 'other' : 'range' }
  const like = /^("?[A-Za-z_$][\w$.]*"?)\s+(NOT\s+)?(I?LIKE)\s+(.+)$/is.exec(text)
  if (like) {
    const pattern = like[4]!
    return { column: stripQuotes(like[1]!), shape: like[2] || pattern.trim().startsWith("'%") || pattern.trim().startsWith("'_") ? 'prefix' : 'range' }
  }
  const comparison = /^("?[A-Za-z_$][\w$.]*"?)\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/s.exec(text)
  if (comparison) {
    const op = comparison[2]!
    const column = stripQuotes(comparison[1]!)
    const right = comparison[3]!.trim()
    const peer = op === '=' && /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(right) ? right : ''
    if (op === '=') return { column, shape: 'equality', peer }
    if (op === '<>' || op === '!=') return { column, shape: 'other' }
    return { column, shape: 'range' }
  }
  return undefined
}

/**
 * Derive composite B-tree index proposals from a script.
 * @param sql - raw SQL script.
 * @param dialect - dialect used for generated DDL.
 * @returns de-duplicated proposals, notes, and the mined statement count.
 */
function suggestIndexes(sql: string, dialect: Dialect): { suggestions: Suggestion[]; notes: string[]; statementCount: number } {
  const { statements, warnings } = analyzeSql(sql, dialect)
  const notes: string[] = [...warnings]
  const buckets = new Map<string, Bucket>()

  const bucketFor = (table: string): Bucket => {
    const key = table.toLowerCase()
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { table, equality: [], set: [], range: [], trailing: [], reasons: new Set<string>(), priority: 3 }
      buckets.set(key, bucket)
    }
    return bucket
  }

  const resolve = (stmt: Stmt, raw: string): { table: string; column: string } | undefined => {
    const cleaned = stripQuotes(raw)
    if (cleaned.length === 0 || cleaned === '*') return undefined
    if (stmt.ctes.some(cte => cte.toLowerCase() === cleaned.toLowerCase() || cleaned.toLowerCase().startsWith(`${cte.toLowerCase()}.`))) return undefined
    const parts = cleaned.split('.')
    if (parts.length === 1) {
      if (stmt.tables.length === 1) return { table: stmt.tables[0]!, column: parts[0]! }
      if (stmt.tables.length === 0) return undefined
      notes.push(`"${cleaned}" is not table-qualified and the statement touches ${stmt.tables.length} tables — skipped`)
      return undefined
    }
    const column = parts[parts.length - 1]!
    const qualifier = parts[parts.length - 2]!
    const table = stmt.alias.get(qualifier.toLowerCase()) ?? qualifier
    if (stmt.ctes.some(cte => cte.toLowerCase() === table.toLowerCase())) return undefined
    if (!stmt.tables.some(t => t.toLowerCase() === table.toLowerCase() || t.toLowerCase().split('.').pop() === table.toLowerCase())) {
      notes.push(`"${cleaned}" refers to unknown relation "${qualifier}" — skipped`)
      return undefined
    }
    return { table, column }
  }

  const add = (table: string, column: string, shape: Predicate['shape'] | 'trailing', reason: string, priority: number): void => {
    const bucket = bucketFor(table)
    bucket.priority = Math.min(bucket.priority, priority)
    if (!bucket.reasons.has(reason)) bucket.reasons.add(reason)
    const target = shape === 'equality' ? bucket.equality : shape === 'set' ? bucket.set : shape === 'range' ? bucket.range : bucket.trailing
    const all = [...bucket.equality, ...bucket.set, ...bucket.range, ...bucket.trailing]
    if (!all.includes(column)) target.push(column)
  }

  for (const stmt of flatten(statements)) {
    for (const predicateText of stmt.predicates) {
      const parsed = parsePredicate(predicateText)
      if (parsed === undefined) {
        if (/[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(=|<|>)/.test(predicateText)) {
          notes.push(`"${predicateText}" wraps its column in a function — no index can seek it`)
        }
        continue
      }
      const resolved = resolve(stmt, parsed.column)
      if (resolved === undefined) continue
      if (parsed.shape === 'other') {
        notes.push(`"${predicateText}" is not sargable — no index column derived from ${resolved.table}.${resolved.column}`)
        continue
      }
      if (parsed.shape === 'prefix') notes.push(`${resolved.table}.${resolved.column}: a LIKE pattern with a leading wildcard needs a text or trigram index, not a B-tree`)
      const peer = parsed.peer === undefined || parsed.peer.length === 0 ? undefined : resolve(stmt, parsed.peer)
      add(resolved.table, resolved.column, parsed.shape, peer === undefined ? 'WHERE filter' : 'join key', parsed.shape === 'equality' ? 1 : 2)
      if (peer !== undefined && parsed.shape === 'equality' && (peer.table !== resolved.table || peer.column !== resolved.column)) {
        add(peer.table, peer.column, 'equality', 'join key', 1)
      }
    }

    for (const join of stmt.joins) {
      if (!/\b(ON|USING)\s/.test(join) && !/^(NATURAL|CROSS)\b/.test(join)) notes.push(`join "${join}" has no ON predicate — nothing to index`)
    }

    const seenJoins = new Set<string>()
    for (const part of stmt.joinParts) {
      const key = `${part.label}|${part.kind}|${part.condition}`
      if (seenJoins.has(key)) continue
      seenJoins.add(key)
      if (part.kind === 'USING') {
        const qualifier = part.label.split(/\s+AS\s+/).pop()!
        for (const raw of part.condition.split(',')) {
          const column = stripQuotes(raw)
          if (column.length === 0) continue
          const resolved = resolve(stmt, column.includes('.') ? column : `${qualifier}.${column}`)
          if (resolved === undefined) continue
          add(resolved.table, resolved.column, 'equality', 'join key', 1)
        }
        continue
      }
      for (const side of part.condition.split(/\s+AND\s+|\s+OR\s+/i)) {
        const trimmed = side.trim()
        const equality = /^("?[A-Za-z_$][\w$.]*"?)\s*=\s*("?[A-Za-z_$][\w$.]*"?)$/.exec(trimmed)
        if (equality) {
          for (const raw of [equality[1]!, equality[2]!]) {
            const resolved = resolve(stmt, raw)
            if (resolved !== undefined) add(resolved.table, resolved.column, 'equality', 'join key', 1)
          }
          continue
        }
        const parsed = parsePredicate(trimmed)
        if (parsed === undefined) continue
        const resolved = resolve(stmt, parsed.column)
        if (resolved === undefined) continue
        add(resolved.table, resolved.column, 'equality', 'join key', 1)
      }
    }

    for (const item of [...stmt.groupBy.map(text => ({ text, reason: 'GROUP BY' })), ...stmt.orderBy.map(text => ({ text, reason: 'ORDER BY' }))]) {
      if (item.text.includes('(')) {
        notes.push(`${item.reason} expression "${item.text}" is computed — an expression index would be required`)
        continue
      }
      const resolved = resolve(stmt, firstColumn(item.text))
      if (resolved === undefined) continue
      add(resolved.table, resolved.column, 'trailing', item.reason, 3)
    }
  }

  const suggestions: Suggestion[] = []
  const seen = new Set<string>()
  for (const bucket of buckets.values()) {
    const columns = [...bucket.equality, ...bucket.set, ...bucket.range, ...bucket.trailing]
    if (columns.length === 0) continue
    if (columns.length > 4) {
      notes.push(`${bucket.table}: ${columns.length} candidate columns — only the first 4 are proposed`)
    }
    const limited = columns.slice(0, 4)
    const name = `idx_${bucket.table}_${limited.join('_')}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 63)
    const key = `${bucket.table.toLowerCase()}|${limited.map(c => c.toLowerCase()).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push({
      table: bucket.table,
      columns: columns.slice(0, 4),
      kind: 'btree',
      reason: [...bucket.reasons].join('; '),
      priority: PRIORITY_LABELS[bucket.priority] ?? 'low',
      ddl: indexDdl(dialect, name, bucket.table, columns.slice(0, 4)),
    })
  }
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
  suggestions.sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3) || compareCi(a.table, b.table) || compareCi(a.columns.join('.'), b.columns.join('.')))
  if (suggestions.length === 0) notes.push('no filterable, joinable, or grouping columns were recognised')
  return { suggestions, notes: unique(notes), statementCount: statements.length }
}

// ---------------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------------

/** Resolve the effective dialect, falling back with a warning. */
function resolveDialect(raw: string | undefined, fallback: string): { dialect: Dialect; warning: string | undefined } {
  const requested = (raw ?? fallback ?? '').trim().toLowerCase()
  const dialect = DIALECT_ALIASES[requested]
  if (dialect !== undefined) return { dialect, warning: undefined }
  return { dialect: 'standard', warning: `unknown dialect "${raw}" — treated as standard SQL` }
}

/** Clamp the requested indent into the supported 1..8 range. */
function resolveIndent(raw: number | undefined, fallback: number): { indent: number; warning: string | undefined } {
  const requested = raw ?? fallback
  if (!Number.isFinite(requested)) return { indent: 2, warning: 'indent was not a finite number — used 2' }
  const indent = Math.min(8, Math.max(1, Math.trunc(requested)))
  if (indent !== requested) return { indent, warning: `indent ${requested} clamped to ${indent}` }
  return { indent, warning: undefined }
}

/** Build a text content block for tool renders. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

const STRING_LIST = { type: 'array', items: { type: 'string' } } as const

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    statementCount: { type: 'integer', required: true, description: 'Number of statements in the script.' },
    statementKinds: { ...STRING_LIST, required: true, description: 'Per-statement ordinal and leading keyword, e.g. "1 SELECT".' },
    tables: { ...STRING_LIST, required: true, description: 'Physical tables and views referenced, including those inside subqueries.' },
    ctes: { ...STRING_LIST, required: true, description: 'Common table expression names defined by the script (virtual, never indexed).' },
    columns: { ...STRING_LIST, required: true, description: 'Columns referenced, qualified as table.column when the alias resolved.' },
    joins: { ...STRING_LIST, required: true, description: 'Join clauses rendered with their ON condition.' },
    predicates: { ...STRING_LIST, required: true, description: 'Top-level WHERE / HAVING predicates.' },
    groupBy: { ...STRING_LIST, required: true, description: 'GROUP BY items.' },
    orderBy: { ...STRING_LIST, required: true, description: 'ORDER BY items.' },
    functions: { ...STRING_LIST, required: true, description: 'Aggregate and window functions used.' },
    subqueries: { type: 'integer', required: true, description: 'Nested SELECT blocks and CTE bodies counted.' },
    complexity: { type: 'integer', required: true, description: 'Heuristic cost: relations, joins, predicates, grouping, aggregates, nesting.' },
    warnings: { ...STRING_LIST, required: true, description: 'Static advisories; empty when nothing stood out.' },
  },
} as const

const SUGGESTION_LIST = {
  type: 'array',
  required: true,
  description: 'Composite index proposals, highest priority first.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table: { type: 'string', required: true, description: 'Relation the index belongs to.' },
      columns: { type: 'array', required: true, description: 'Index columns in proposal order: equality, then set/range, then GROUP BY / ORDER BY.', items: { type: 'string' } },
      kind: { type: 'string', required: true, description: 'Access method assumed; always "btree".' },
      reason: { type: 'string', required: true, description: 'Why these columns were chosen.' },
      priority: { type: 'string', required: true, description: 'high, medium, or low.' },
      ddl: { type: 'string', required: true, description: 'Ready-to-run CREATE INDEX statement for the dialect.' },
    },
  },
} as const

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register the SQL tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment defaults for dialect, indent, and keyword case.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'sql_format',
    description:
      'Pretty-print a SQL script with a clause-aware formatter and no database involved. ' +
      'Pass the whole script in `text`; every statement ends with ";" and statements are separated by a blank line. ' +
      'Optional `dialect` (standard | mysql | postgresql | sqlite | transactsql | oracle) selects lexical rules and ' +
      'optional `indent` (1..8 spaces, default from plugin config) selects width; `uppercaseKeywords` defaults to true. ' +
      'Clause keywords start a new line, projections and multi-row VALUES list one item per line, joins and subqueries ' +
      'are indented, and string literals, identifiers, and comments keep their exact source text.',
    parameters: {
      text: { type: 'string', required: true, description: 'The SQL script to format.' },
      dialect: { type: 'string', description: 'Lexical dialect override; unknown names fall back to standard with a warning.' },
      indent: { type: 'integer', description: 'Spaces per indentation level, clamped to 1..8.' },
      uppercaseKeywords: { type: 'boolean', description: 'Upper-case keywords (default true); false emits them lower-cased.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          formatted: { type: 'string', required: true, description: 'The pretty-printed script.' },
          dialect: { type: 'string', required: true, description: 'Dialect actually used.' },
          indent: { type: 'integer', required: true, description: 'Indentation width actually used.' },
          tokenCount: { type: 'integer', required: true, description: 'Tokens produced by the lexer.' },
          statementCount: { type: 'integer', required: true, description: 'Statements recognised in the script.' },
          warnings: { ...STRING_LIST, required: true, description: 'Lexical problems: unterminated literal, comment, or unbalanced parenthesis.' },
        },
      },
      render: (_args, value) => text(value.warnings.length > 0
        ? `${value.formatted}\n\n-- warnings: ${value.warnings.join('; ')}`
        : value.formatted),
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const dialect = resolveDialect(args.dialect, config.dialect)
      const indent = resolveIndent(args.indent, config.indent)
      const result = formatSql(args.text ?? '', {
        dialect: dialect.dialect,
        indent: indent.indent,
        uppercaseKeywords: args.uppercaseKeywords ?? config.uppercaseKeywords,
      })
      return Promise.resolve({
        formatted: result.formatted,
        dialect: dialect.dialect,
        indent: indent.indent,
        tokenCount: result.tokenCount,
        statementCount: result.statementCount,
        warnings: unique([...result.warnings, dialect.warning, indent.warning].filter((w): w is string => w !== undefined)),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sql_analyze',
    description:
      'Statically analyze a SQL script (including subqueries and CTEs) and report its shape: statement count and ' +
      'kinds, referenced tables, columns qualified as table.column where an alias resolves, join clauses with their ' +
      'ON condition, top-level WHERE/HAVING predicates, GROUP BY and ORDER BY items, aggregate functions used, a ' +
      'nested-query count, and a complexity score. Also flags risks that need no database: SELECT *, UPDATE/DELETE ' +
      'without WHERE, joins lacking ON, implicit comma cross joins, leading-wildcard LIKE, and dialect mismatches ' +
      'such as LIMIT on Oracle or SQL Server. Nothing is executed and no connection is opened.',
    parameters: {
      text: { type: 'string', required: true, description: 'The SQL script to analyze (one or more statements).' },
      dialect: { type: 'string', description: 'Lexical dialect override; unknown names fall back to standard with a warning.' },
    },
    output: {
      schema: ANALYSIS_SCHEMA,
      render: (_args, value) => text([
        `${value.statementCount} statement(s) [${value.statementKinds.join(', ')}] — complexity ${value.complexity}, nested queries ${value.subqueries}`,
        `tables: ${value.tables.length > 0 ? value.tables.join(', ') : '(none)'}`,
        ...(value.ctes.length > 0 ? [`cte names: ${value.ctes.join(', ')}`] : []),
        `columns: ${value.columns.length > 0 ? value.columns.join(', ') : '(none)'}`,
        ...(value.joins.length > 0 ? [`joins: ${value.joins.join(' | ')}`] : []),
        ...(value.predicates.length > 0 ? [`predicates: ${value.predicates.join(' | ')}`] : []),
        ...(value.groupBy.length > 0 ? [`group by: ${value.groupBy.join(', ')}`] : []),
        ...(value.orderBy.length > 0 ? [`order by: ${value.orderBy.join(', ')}`] : []),
        ...(value.functions.length > 0 ? [`functions: ${value.functions.join(', ')}`] : []),
        ...(value.warnings.length > 0 ? ['warnings:', ...value.warnings.map(warning => `- ${warning}`)] : []),
      ].join('\n')),
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const dialect = resolveDialect(args.dialect, config.dialect)
      const { analysis, warnings } = analyzeSql(args.text ?? '', dialect.dialect)
      return Promise.resolve({
        ...analysis,
        warnings: unique([...analysis.warnings, ...warnings, dialect.warning].filter((w): w is string => w !== undefined)),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sql_index_suggestions',
    description:
      'Mine a SQL script for composite index candidates from WHERE, JOIN ON, GROUP BY, and ORDER BY usage — no catalog ' +
      'access and nothing executed. Equality predicates come first in a proposed key, then IN sets and range or LIKE ' +
      'predicates, then GROUP BY / ORDER BY spool columns, capped at four columns per index; join keys are proposed on ' +
      'both sides. Returns one CREATE INDEX statement per proposal in the requested dialect plus notes explaining every ' +
      'skipped, unresolvable, or non-sargable predicate.',
    parameters: {
      text: { type: 'string', required: true, description: 'The SQL script to mine for index candidates.' },
      dialect: { type: 'string', description: 'Dialect for the generated DDL; defaults to the configured dialect.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          suggestions: SUGGESTION_LIST,
          notes: { ...STRING_LIST, required: true, description: 'Advisories explaining skipped, unqualified, or non-sargable predicates.' },
          statementCount: { type: 'integer', required: true, description: 'Statements mined.' },
        },
      },
      render: (_args, value) => text(value.suggestions.length === 0
        ? `No index proposals.\n${value.notes.map(note => `- ${note}`).join('\n')}`
        : [
          `${value.suggestions.length} index proposal(s):`,
          ...value.suggestions.map(s => `- [${s.priority}] ${s.table} (${s.columns.join(', ')}) — ${s.reason}\n  ${s.ddl}`),
          ...(value.notes.length > 0 ? ['notes:', ...value.notes.map(note => `- ${note}`)] : []),
        ].join('\n')),
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const dialect = resolveDialect(args.dialect, config.dialect)
      const result = suggestIndexes(args.text ?? '', dialect.dialect)
      return Promise.resolve({
        suggestions: result.suggestions,
        notes: dialect.warning === undefined ? result.notes : unique([...result.notes, dialect.warning]),
        statementCount: result.statementCount,
      })
    },
  }))
}
