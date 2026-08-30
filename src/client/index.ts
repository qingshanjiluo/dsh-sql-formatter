import React from 'react';

const NS = 'sql-formatter';

const zh = {
  title: 'SQL 格式化',
  description: 'SQL 格式化、分析、优化、索引建议',
  enabled: '启用插件',
  dialect: 'SQL 方言',
  indentSize: '缩进大小',
};

const en = {
  title: 'SQL Formatter',
  description: 'SQL format, analyze, optimize, index suggestions',
  enabled: 'Enable plugin',
  dialect: 'SQL dialect',
  indentSize: 'Indent size',
};

export const inject = ['settingsScope', 'slots', 'locale'];

export function apply(ctx: any) {
  ctx.effect?.(() => ctx.locale?.register?.(NS, { zh, en }), `dsh-${NS}: locale`);
  ctx.effect?.(() => {
    ctx.slots?.inject?.('settings.plugin.item', function* () {
      yield ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({}) }, Card);
    });
  }, `dsh-${NS}: settings`);
}

function Card(props: any) {
  const { scope, t } = props;
  const [open, setOpen] = React.useState(false);
  const s = { background: '#1a1a2e', color: '#e0e0e0', borderRadius: '8px', padding: '12px', marginBottom: '8px', border: '1px solid #333' } as React.CSSProperties;
  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', cursor: 'pointer', borderRadius: '4px', transition: 'background 0.15s' } as React.CSSProperties;
  const label = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', marginBottom: '6px' } as React.CSSProperties;

  return React.createElement('li', { className: `dsh-${NS}-card`, style: s },
    React.createElement('div', { style: row, onClick: () => setOpen(!open), onMouseEnter: (e: any) => e.currentTarget.style.background = '#252540', onMouseLeave: (e: any) => e.currentTarget.style.background = 'transparent' },
      React.createElement('div', null,
        React.createElement('strong', { style: { fontSize: '14px' } }, '\u2728 ', t('title')),
        React.createElement('p', { style: { margin: '2px 0 0', fontSize: '12px', color: '#888' } }, t('description')),
      ),
      React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, open ? '\u25B2' : '\u25BC'),
    ),
    open ? React.createElement('div', { style: { padding: '8px 0', borderTop: '1px solid #333' } },
      React.createElement('label', { style: label },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('enabled') ?? true, onChange: (e: any) => scope?.set?.('enabled', e.target.checked) }),
        t('enabled'),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
        React.createElement('label', { style: { fontSize: '13px', minWidth: '100px' } }, t('dialect')),
        React.createElement('select', { value: scope?.get?.('dialect') ?? 'auto', onChange: (e: any) => scope?.set?.('dialect', e.target.value), style: { flex: 1, padding: '4px 8px', borderRadius: '4px', border: '1px solid #444', background: '#0d0d1a', color: '#e0e0e0', fontSize: '13px', cursor: 'pointer' } },
          React.createElement('option', { value: 'auto' }, 'Auto'),
          React.createElement('option', { value: 'mysql' }, 'MySQL'),
          React.createElement('option', { value: 'postgresql' }, 'PostgreSQL'),
          React.createElement('option', { value: 'sqlite' }, 'SQLite'),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement('label', { style: { fontSize: '13px', minWidth: '100px' } }, t('indentSize')),
        React.createElement('input', { type: 'number', min: 1, max: 8, value: scope?.get?.('indentSize') ?? 2, onChange: (e: any) => scope?.set?.('indentSize', Number(e.target.value) || 2), style: { width: '60px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #444', background: '#0d0d1a', color: '#e0e0e0', fontSize: '13px' } }),
      ),
    ) : null,
  );
}
