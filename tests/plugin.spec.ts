import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'

interface RegisteredTool {
  name: string
  description: string
  parameters: { properties: Record<string, unknown> }
  output: { schema: unknown; render(args: never, value: never): unknown[] }
  isConcurrencySafe?(args: never): boolean
  execute(args: never, exec?: never): Promise<Record<string, any>>
}

/** Mount the plugin against a stub registry and return what it registered. */
function mountPlugin(config: { dialect: string; indent: number; uppercaseKeywords: boolean }): RegisteredTool[] {
  const registered: RegisteredTool[] = []
  // The plugin only touches ctx.tools, so a partial stub is the real surface.
  apply({ tools: { register: (def: RegisteredTool) => registered.push(def) } } as never, config as never)
  return registered
}

const TOOLS = mountPlugin({ dialect: 'standard', indent: 2, uppercaseKeywords: true })
const tool = (toolName: string): RegisteredTool => {
  const found = TOOLS.find(candidate => candidate.name === toolName)
  if (found === undefined) throw new Error(`${toolName} was not registered`)
  return found
}

const run = (toolName: string, args: Record<string, unknown>): Promise<Record<string, any>> =>
  tool(toolName).execute(args as never, {} as never)

describe('dsh-sql-formatter plugin contract', () => {
  it('exports the loader plugin face', () => {
    expect(name).toBe('dsh-sql-formatter')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeInstanceOf(Object)
  })

  it('registers the three documented tools with pure concurrency-safe definitions', () => {
    expect(TOOLS.map(registered => registered.name).sort()).toEqual(['sql_analyze', 'sql_format', 'sql_index_suggestions'])
    for (const registered of TOOLS) {
      expect(registered.description.length).toBeGreaterThan(40)
      expect(registered.parameters.properties.text).toBeInstanceOf(Object)
      expect(registered.output.schema).toBeInstanceOf(Object)
      expect(typeof registered.output.render).toBe('function')
      expect(typeof registered.execute).toBe('function')
      // Concurrency is gated on valid arguments by `defineTool`.
      expect(registered.isConcurrencySafe?.({ text: 'select 1' } as never)).toBe(true)
      expect(registered.isConcurrencySafe?.({} as never)).toBe(false)
    }
  })

  it('renders model-facing text for each tool', async () => {
    const formatted = await run('sql_format', { text: 'select 1' })
    expect(tool('sql_format').output.render({} as never, formatted as never)).toEqual([
      { type: 'text', text: expect.any(String) },
    ])
    const analyzed = await run('sql_analyze', { text: 'select 1' })
    expect(JSON.stringify(tool('sql_analyze').output.render({} as never, analyzed as never))).toContain('statement')
    const indexed = await run('sql_index_suggestions', { text: 'select 1' })
    expect(JSON.stringify(tool('sql_index_suggestions').output.render({} as never, indexed as never))).toContain('index')
  })
})

describe('sql_format', () => {
  it('breaks clauses onto lines and lists projections one per line', async () => {
    const result = await run('sql_format', { text: 'select a,b from users where id = 1' })
    expect(result.formatted).toBe('SELECT\n  a,\n  b\nFROM\n  users\nWHERE\n  id = 1')
    expect(result.dialect).toBe('standard')
    expect(result.indent).toBe(2)
    expect(result.statementCount).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it('indents joins, subqueries, and multi-row VALUES', async () => {
    const joined = await run('sql_format', { text: 'select a from users u left join orders o on o.uid = u.id and o.x = 1' })
    expect(joined.formatted).toBe([
      'SELECT',
      '  a',
      'FROM',
      '  users u',
      '  LEFT JOIN orders o ON o.uid = u.id',
      '    AND o.x = 1',
    ].join('\n'))

    const sub = await run('sql_format', { text: 'select id from (select id from people where age > 18) x' })
    expect(sub.formatted).toBe([
      'SELECT',
      '  id',
      'FROM',
      '  (',
      '    SELECT',
      '      id',
      '    FROM',
      '      people',
      '    WHERE',
      '      age > 18',
      '  ) x',
    ].join('\n'))

    const rows = await run('sql_format', { text: "insert into users (id, name) values (1, 'a'), (2, 'b')" })
    expect(rows.formatted).toBe("INSERT INTO\n  users (id, name)\nVALUES\n  (1, 'a'),\n  (2, 'b')")
  })

  it('honours indent, keyword case, and dialect overrides', async () => {
    const wide = await run('sql_format', { text: 'select a from t', indent: 4 })
    expect(wide.formatted).toBe('SELECT\n    a\nFROM\n    t')
    expect(wide.indent).toBe(4)

    const lower = await run('sql_format', { text: 'SELECT a FROM t WHERE b = 2', uppercaseKeywords: false })
    expect(lower.formatted).toBe('select\n  a\nfrom\n  t\nwhere\n  b = 2')

    const mysql = await run('sql_format', { text: 'select `a b`, "c" from t where x = \'it\'\'s\'', dialect: 'mysql' })
    expect(mysql.dialect).toBe('mysql')
    expect(mysql.formatted).toContain('`a b`,')
    expect(mysql.formatted).toContain("x = 'it''s'")

    const postgres = await run('sql_format', { text: 'select $$a$b$$ from t', dialect: 'postgresql' })
    expect(postgres.formatted).toContain('$$a$b$$')
  })

  it('preserves literals and comments verbatim', async () => {
    const result = await run('sql_format', { text: "select n from t /* keep */ where n = 'a,b' and m = \"weird, string\"" })
    expect(result.formatted).toContain("'a,b'")
    expect(result.formatted).toContain('/* keep */')
    expect(result.formatted).toContain('"weird, string"')
  })

  it('handles empty input, unbalanced parentheses, and bad overrides', async () => {
    const empty = await run('sql_format', { text: '   \n  ' })
    expect(empty.formatted).toBe('')
    expect(empty.tokenCount).toBe(0)
    expect(empty.statementCount).toBe(0)

    const broken = await run('sql_format', { text: 'select a from (t', dialect: 'cobol', indent: 99 })
    expect(broken.dialect).toBe('standard')
    expect(broken.indent).toBe(8)
    expect(broken.warnings.join('\n')).toContain('unclosed')
    expect(broken.warnings.join('\n')).toContain('unknown dialect')
    expect(broken.warnings.join('\n')).toContain('clamped')

    const unterminated = await run('sql_format', { text: "select 'oops" })
    expect(unterminated.warnings.join('\n')).toContain('unterminated string')
  })

  it('separates multiple statements and is deterministic', async () => {
    const once = await run('sql_format', { text: 'select a from t; update t set a = 1;' })
    const twice = await run('sql_format', { text: 'select a from t; update t set a = 1;' })
    expect(once.statementCount).toBe(2)
    expect(once.formatted).toContain(';\n\nUPDATE')
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})

describe('sql_analyze', () => {
  it('reports tables, qualified columns, joins, predicates, and aggregates', async () => {
    const result = await run('sql_analyze', {
      text: 'select u.id, u.name, count(o.id) as c from users u join orders o on o.uid = u.id where u.active = 1 and o.total > 100 group by u.name having count(o.id) > 2 order by u.name desc',
    })
    expect(result.statementCount).toBe(1)
    expect(result.statementKinds).toEqual(['1 SELECT'])
    expect(result.tables).toEqual(['orders', 'users'])
    expect(result.columns).toEqual(expect.arrayContaining(['users.id', 'users.name', 'users.active', 'orders.uid', 'orders.total']))
    expect(result.joins).toEqual(['JOIN orders AS o ON o.uid = u.id'])
    expect(result.predicates).toEqual(expect.arrayContaining(['u.active = 1', 'o.total > 100']))
    expect(result.groupBy).toEqual(['u.name'])
    expect(result.orderBy).toEqual(['u.name desc'])
    expect(result.functions).toEqual(['COUNT'])
    expect(result.subqueries).toBe(0)
    expect(result.complexity).toBeGreaterThan(5)
  })

  it('sees through subqueries and common table expressions', async () => {
    const result = await run('sql_analyze', {
      text: 'with recent as (select id from events where occurred_at > 100) select a.owner from accounts a join recent r on r.id = a.eid',
    })
    expect(result.statementKinds).toEqual(['1 SELECT'])
    expect(result.tables).toEqual(['accounts', 'events'])
    expect(result.ctes).toEqual(['recent'])
    expect(result.subqueries).toBe(1)
    expect(result.columns).toEqual(expect.arrayContaining(['events.occurred_at', 'accounts.owner', 'accounts.eid']))

    const derived = await run('sql_analyze', { text: 'select x.id from (select id from people where age > 18) as x' })
    expect(derived.tables).toEqual(['people'])
    expect(derived.columns).toEqual(['people.age', 'people.id'])
  })

  it('flags risky statements and dialect mismatches', async () => {
    const unguarded = await run('sql_analyze', { text: 'update users set a = 1' })
    expect(unguarded.warnings.join('\n')).toContain('no WHERE clause')

    const star = await run('sql_analyze', { text: "select * from logs l where l.msg like '%error%'" })
    expect(star.warnings.join('\n')).toContain('SELECT *')
    expect(star.warnings.join('\n')).toContain('LIKE pattern begins with %')

    const oracle = await run('sql_analyze', { text: 'select id from t limit 10', dialect: 'oracle' })
    expect(oracle.dialect ?? 'oracle').toBeDefined()
    expect(oracle.warnings.join('\n')).toContain('LIMIT is not valid in oracle')

    const mysqlReturning = await run('sql_analyze', { text: 'delete from t where a = 1 returning id', dialect: 'mysql' })
    expect(mysqlReturning.warnings.join('\n')).toContain('MySQL has no RETURNING')
  })

  it('returns an empty report for empty input', async () => {
    const result = await run('sql_analyze', { text: '  ' })
    expect(result.statementCount).toBe(0)
    expect(result.tables).toEqual([])
    expect(result.columns).toEqual([])
    expect(result.complexity).toBe(0)
    expect(result.warnings).toEqual([])
  })
})

describe('sql_index_suggestions', () => {
  it('orders equality before range and appends grouping columns with DDL', async () => {
    const result = await run('sql_index_suggestions', {
      text: "select o.id from orders o where o.status = 'paid' and o.created_at > 100 group by o.region",
    })
    expect(result.statementCount).toBe(1)
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({
      table: 'orders',
      columns: ['status', 'created_at', 'region'],
      kind: 'btree',
      priority: 'high',
    })
    expect(result.suggestions[0].ddl).toBe('CREATE INDEX idx_orders_status_created_at_region ON orders (status, created_at, region);')
    expect(result.suggestions[0].reason).toContain('WHERE filter')
    expect(result.suggestions[0].reason).toContain('GROUP BY')
  })

  it('proposes a key on both sides of a join and per-dialect DDL', async () => {
    const both = await run('sql_index_suggestions', { text: 'select x from orders o join users u on u.id = o.uid' })
    const byTable = Object.fromEntries(both.suggestions.map((s: Record<string, unknown>) => [s.table as string, s.columns]))
    expect(byTable).toEqual({ orders: ['uid'], users: ['id'] })

    const pg = await run('sql_index_suggestions', { text: 'select id from users where tenant_id = 5', dialect: 'postgresql' })
    expect(pg.suggestions[0].ddl).toBe('CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users USING btree (tenant_id);')

    const tsql = await run('sql_index_suggestions', { text: 'select id from users where tenant_id = 5', dialect: 'mssql' })
    expect(tsql.suggestions[0].ddl).toBe('CREATE NONCLUSTERED INDEX idx_users_tenant_id ON users (tenant_id);')

    const using = await run('sql_index_suggestions', { text: 'select o.id from orders o join users u using (user_id)' })
    expect(using.suggestions.map((s: Record<string, unknown>) => `${s.table}:${(s.columns as string[]).join('+')}`)).toEqual(['orders:user_id', 'users:user_id'])
  })

  it('explains skipped, unqualified, and non-sargable predicates', async () => {
    const result = await run('sql_index_suggestions', {
      text: 'select a from t1, t2 where t1.x = 1 and z = 2 and year(created_at) = 2020 and t1.w <> 3',
    })
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({ table: 't1', columns: ['x'] })
    const notes = result.notes.join('\n')
    expect(notes).toContain('is not table-qualified')
    expect(notes).toContain('wraps its column in a function')
    expect(notes).toContain('is not sargable')
  })

  it('indexes both sides of an old-style comma join and stays quiet on natural joins', async () => {
    const comma = await run('sql_index_suggestions', { text: 'select a from x, y where x.id = y.id' })
    expect(comma.suggestions.map((s: Record<string, unknown>) => `${s.table}:${(s.columns as string[]).join('+')}`)).toEqual(['x:id', 'y:id'])
    expect(comma.suggestions[0].reason).toContain('join key')

    const natural = await run('sql_index_suggestions', { text: 'select id from a natural join b' })
    expect(natural.suggestions).toEqual([])
    expect(natural.notes).toEqual(['no filterable, joinable, or grouping columns were recognised'])

    const warned = await run('sql_analyze', { text: 'select a from x, y where x.id = y.id' })
    expect(warned.warnings.join('\n')).toContain('implicit cross join')

    const inList = await run('sql_analyze', { text: 'select a from t where b in (1, 2, 3)' })
    expect(inList.warnings).toEqual([])
  })

  it('skips virtual CTE relations and reports nothing for constant selects', async () => {
    const cte = await run('sql_index_suggestions', {
      text: 'with recent as (select id from events where occurred_at > 100) select a.owner from accounts a join recent r on r.id = a.eid',
    })
    expect(cte.suggestions.map((s: Record<string, unknown>) => s.table)).toEqual(['accounts', 'events'])
    expect(cte.suggestions.some((s: Record<string, unknown>) => s.table === 'recent')).toBe(false)

    const constant = await run('sql_index_suggestions', { text: 'select 1' })
    expect(constant.suggestions).toEqual([])
    expect(constant.notes.join('\n')).toContain('no filterable, joinable, or grouping columns')

    const empty = await run('sql_index_suggestions', { text: '' })
    expect(empty.statementCount).toBe(0)
    expect(empty.suggestions).toEqual([])
  })
})
