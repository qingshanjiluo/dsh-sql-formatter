/**
 * Loads the built artifact and asserts it exports the Cordis function-plugin
 * face the harness loader requires, then mounts it against a stub registry.
 * Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'dsh-sql-formatter', 'plugin name export')
assert.deepEqual(mod.inject, ['tools'], 'inject declares the tools service')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config schema export present')
assert.equal(mod.default, undefined, 'no default export (Cordis loads named exports)')

const registered = []
mod.apply({ tools: { register: def => registered.push(def) } }, { dialect: 'standard', indent: 2, uppercaseKeywords: true })

assert.deepEqual(
  registered.map(tool => tool.name).sort(),
  ['sql_analyze', 'sql_format', 'sql_index_suggestions'],
  'the three documented tools register',
)
for (const tool of registered) {
  assert.equal(typeof tool.execute, 'function', `${tool.name} executes`)
  assert.equal(typeof tool.output.render, 'function', `${tool.name} renders`)
  assert.ok(tool.parameters.properties.text, `${tool.name} takes SQL text`)
}

// One real call through the built artifact proves the schema compiles and the
// pure logic survived bundling.
const format = registered.find(tool => tool.name === 'sql_format')
const result = await format.execute({ text: 'select a,b from t where x=1' }, {})
assert.equal(result.formatted.split('\n')[0], 'SELECT', 'built formatter emits SQL')
assert.equal(result.dialect, 'standard', 'built formatter reports its dialect')

console.log(`ok — ${registered.length} tools registered from built artifact`)
