/**
 * dsh-sql-formatter — SQL格式化与优化
 *
 * 功能：
 * 1. SQL美化
 * 2. 查询分析
 * 3. 优化建议
 * 4. 索引建议
 *
 * 工具：sql_format, sql_analyze, sql_optimize, sql_indexes
 * 命令：/sql
 * 配置：enabled, dialect
 */
import { z } from 'zod';

export const name = 'dsh-sql-formatter';
export const inject = ['settings', 'tools', 'commands'];

const configSchema = z.object({
  enabled: z.boolean().default(true),
  dialect: z.enum(['standard', 'mysql', 'postgresql', 'sqlite']).default('standard'),
  indentSize: z.number().int().min(1).max(8).default(2),
});

type Config = z.infer<typeof configSchema>;

const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IN', 'NOT', 'NULL', 'IS', 'BETWEEN', 'LIKE', 'EXISTS', 'UNION', 'ALL', 'WITH', 'RECURSIVE'];

function tokenize(sql: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === ' ' || sql[i] === '\n' || sql[i] === '\t') {
      while (i < sql.length && (sql[i] === ' ' || sql[i] === '\n' || sql[i] === '\t')) i++;
      tokens.push(' ');
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let str = quote;
      i++;
      while (i < sql.length && sql[i] !== quote) { str += sql[i]; i++; }
      if (i < sql.length) { str += sql[i]; i++; }
      tokens.push(str);
    } else if (/[0-9]/.test(sql[i])) {
      let num = '';
      while (i < sql.length && /[0-9.]/.test(sql[i])) { num += sql[i]; i++; }
      tokens.push(num);
    } else if (/[a-zA-Z_]/.test(sql[i])) {
      let word = '';
      while (i < sql.length && /[a-zA-Z0-9_]/.test(sql[i])) { word += sql[i]; i++; }
      tokens.push(word);
    } else {
      tokens.push(sql[i]); i++;
    }
  }
  return tokens;
}

function formatSQL(sql: string, indent: number = 2): string {
  const tokens = tokenize(sql.replace(/\s+/g, ' ').trim());
  const prettyKeywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'WITH'];
  let result = '';
  let indentLevel = 0;
  const pad = () => ' '.repeat(indent * indentLevel);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const upper = token.toUpperCase();
    const nextToken = tokens[i + 1]?.toUpperCase();
    if (upper === 'SELECT') { result += pad() + 'SELECT\n'; indentLevel++; }
    else if (upper === 'FROM') { indentLevel--; result += pad() + 'FROM\n'; indentLevel++; }
    else if (upper === 'WHERE') { result += pad() + 'WHERE\n'; indentLevel++; }
    else if (upper === 'AND') { result += pad() + 'AND\n'; }
    else if (upper === 'OR') { result += pad() + 'OR\n'; }
    else if (upper === 'GROUP' && nextToken === 'BY') { result += pad() + 'GROUP BY\n'; i++; indentLevel--; }
    else if (upper === 'ORDER' && nextToken === 'BY') { result += pad() + 'ORDER BY\n'; i++; }
    else if (upper === 'HAVING') { result += pad() + 'HAVING\n'; }
    else if (upper === 'LIMIT') { result += pad() + 'LIMIT\n'; }
    else if (upper === 'JOIN' || upper === 'LEFT' || upper === 'RIGHT' || upper === 'INNER') {
      let joinType = upper;
      if (upper !== 'JOIN' && nextToken === 'JOIN') { joinType += ' JOIN'; i++; }
      result += pad() + joinType + '\n';
    }
    else if (token === ',') { result += ',\n' + pad(); }
    else if (token === ' ') { /* skip */ }
    else { result += (result.endsWith('\n') ? pad() : ' ') + token; }
  }
  return result.trim();
}

function analyzeQuery(sql: string) {
  const upper = sql.toUpperCase();
  const issues: string[] = [];
  if (upper.includes('SELECT *')) issues.push('使用了 SELECT *，建议明确列出字段');
  if (upper.includes('WHERE 1=1')) issues.push('WHERE 1=1 通常是动态拼接的痕迹');
  if (!upper.includes('LIMIT') && (upper.includes('SELECT') && !upper.includes('COUNT'))) issues.push('缺少 LIMIT 子句，可能返回大量数据');
  if (upper.includes('LIKE') && !upper.includes('LIKE \'%')) issues.push('LIKE 未使用前缀通配符，可能无法使用索引');
  if ((upper.match(/JOIN/g) || []).length > 3) issues.push('JOIN 数量过多，考虑优化查询或使用子查询');
  const subqueryCount = (upper.match(/SELECT/g) || []).length - 1;
  if (subqueryCount > 2) issues.push(`包含 ${subqueryCount} 个子查询，考虑使用 CTE 或 JOIN 重写`);
  return { issues, complexity: Math.min(10, 1 + issues.length + subqueryCount), hasSubquery: subqueryCount > 0, joinCount: (upper.match(/JOIN/g) || []).length };
}

function suggestIndexes(sql: string): string[] {
  const suggestions: string[] = [];
  const upper = sql.toUpperCase();
  const whereMatch = upper.match(/WHERE\s+(\w+)\s*(=|>|<|>=|<=|LIKE|IN|BETWEEN)/);
  if (whereMatch) suggestions.push(`建议为 \`${whereMatch[1]}\` 创建索引`);
  const orderMatch = upper.match(/ORDER\s+BY\s+(\w+)/);
  if (orderMatch) suggestions.push(`建议为 \`${orderMatch[1]}\` 创建索引`);
  const joinMatch = upper.match(/ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/);
  if (joinMatch) suggestions.push(`建议为 \`${joinMatch[1]}.${joinMatch[2]}\` 和 \`${joinMatch[3]}.${joinMatch[4]}\` 创建索引`);
  if (upper.includes('GROUP BY')) {
    const groupMatch = upper.match(/GROUP\s+BY\s+(\w+)/);
    if (groupMatch) suggestions.push(`建议为 \`${groupMatch[1]}\` 创建索引`);
  }
  return suggestions;
}

function optimizeQuery(sql: string): string[] {
  const suggestions: string[] = [];
  const upper = sql.toUpperCase();
  if (upper.includes('SELECT *')) suggestions.push('避免 SELECT *，只查询需要的字段');
  if (upper.includes('NOT IN')) suggestions.push('NOT IN 性能较差，考虑使用 NOT EXISTS 或 LEFT JOIN ... IS NULL');
  if (upper.includes('OR')) suggestions.push('OR 条件可能阻止索引使用，考虑使用 UNION ALL');
  if (upper.includes('DISTINCT')) suggestions.push('DISTINCT 通常意味着重复数据，考虑是否需要优化数据模型');
  if (upper.match(/WHERE.*!=/) || upper.match(/WHERE.*<>/)) suggestions.push('不等于条件通常无法使用索引');
  return suggestions;
}

export function apply(ctx: any, config: Config) {
  if (!config.enabled) return;

  ctx.effect(() => ctx.tools.register({
    name: 'sql_format',
    description: '格式化 SQL 语句，美化缩进和关键字。',
    parameters: { sql: { type: 'string', description: '要格式化的 SQL 语句' }, indent: { type: 'number', description: '缩进空格数（默认 2）' } },
    output: { schema: { type: 'text' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `\`\`\`sql\n${v}\n\`\`\`` }] },
    async execute(args: { sql: string; indent?: number }) { return formatSQL(args.sql, args.indent || config.indentSize); },
  }), 'dsh-sql-formatter: format');

  ctx.effect(() => ctx.tools.register({
    name: 'sql_analyze',
    description: '分析 SQL 查询的复杂度和潜在问题。',
    parameters: { sql: { type: 'string', description: '要分析的 SQL 语句' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => {
      const r = v as any;
      const lines = [`## 📊 SQL 分析\n复杂度: ${r.complexity}/10`];
      if (r.issues.length) lines.push('### 问题\n' + r.issues.map((i: string) => `- ⚠️ ${i}`).join('\n'));
      lines.push(`JOIN: ${r.joinCount} | 子查询: ${r.hasSubquery ? '有' : '无'}`);
      return [{ type: 'text', text: lines.join('\n') }];
    }},
    async execute(args: { sql: string }) { return analyzeQuery(args.sql); },
  }), 'dsh-sql-formatter: analyze');

  ctx.effect(() => ctx.tools.register({
    name: 'sql_optimize',
    description: '分析 SQL 并给出优化建议。',
    parameters: { sql: { type: 'string', description: '要优化的 SQL 语句' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => {
      const s = v as string[];
      if (s.length === 0) return [{ type: 'text', text: '✅ 查询已经是最佳实践' }];
      return [{ type: 'text', text: `## ⚡ 优化建议\n` + s.map(i => `- ${i}`).join('\n') }];
    }},
    async execute(args: { sql: string }) { return optimizeQuery(args.sql); },
  }), 'dsh-sql-formatter: optimize');

  ctx.effect(() => ctx.tools.register({
    name: 'sql_indexes',
    description: '根据 SQL 查询建议创建索引。',
    parameters: { sql: { type: 'string', description: 'SQL 语句' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => {
      const s = v as string[];
      if (s.length === 0) return [{ type: 'text', text: '无需额外索引' }];
      return [{ type: 'text', text: `## 🔍 索引建议\n` + s.join('\n') }];
    }},
    async execute(args: { sql: string }) { return suggestIndexes(args.sql); },
  }), 'dsh-sql-formatter: indexes');

  ctx.effect(() => ctx.commands.register({
    name: 'sql',
    description: 'SQL 格式化工具',
    input: { hint: 'format <sql> | analyze <sql> | optimize <sql>' },
    async handler(invocation: any) {
      const parts = invocation.rawInput.trim().split(/\s+/);
      const cmd = parts[0];
      const sql = parts.slice(1).join(' ');
      if (cmd === 'format') return { kind: 'text', text: formatSQL(sql) };
      if (cmd === 'analyze') { const r = analyzeQuery(sql); return { kind: 'text', text: `复杂度: ${r.complexity}/10 | 问题: ${r.issues.length}` }; }
      return { kind: 'text', text: '用法: /sql format|analyze|optimize <sql>' };
    },
  }), 'dsh-sql-formatter: command');

  ctx.inject(['settings'], (sctx: any) => {
    const { settingsNamespace } = require('@deepseek-ai/dsh-settings');
    sctx.settings.register(settingsNamespace('sql-formatter'), configSchema, { base: config, expose: true, applies: 'live' });
  });
}
