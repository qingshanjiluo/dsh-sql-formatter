import React from 'react';
const NS = 'sql-formatter';
const zh = { title: 'SQL 格式化', description: 'SQL 格式化、分析、优化、索引建议', enabled: '启用插件', dialect: 'SQL 方言', indentSize: '缩进大小' };
const en = { title: 'SQL Formatter', description: 'SQL format, analyze, optimize, index suggestions', enabled: 'Enable plugin', dialect: 'SQL dialect', indentSize: 'Indent size' };
export const inject = ['settingsScope', 'slots', 'locale'];
export function apply(ctx: any) {
  ctx.effect?.(() => ctx.locale?.register?.(NS, { zh, en }), 'dsh-sql-formatter: locale');
  ctx.effect?.(() => { ctx.slots?.inject?.('settings.plugin.item', function* () { yield ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({}) }, Card); }); }, 'dsh-sql-formatter: settings');
}
function Card(props: any) {
  const { scope, t } = props;
  const [open, setOpen] = React.useState(false);
  return React.createElement('li', null,
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', cursor: 'pointer' }, onClick: () => setOpen(!open) },
      React.createElement('strong', null, '✨ ', t('title')),
      React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, open ? '▲' : '▼')),
    open ? React.createElement('div', { style: { padding: '8px 0', borderTop: '1px solid #333' } },
      React.createElement('label', { style: { display: 'flex', gap: '8px', cursor: 'pointer', marginBottom: '8px' } },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('enabled') ?? true, onChange: (e: any) => scope?.set?.('enabled', e.target.checked) }), t('enabled'))) : null);
}
