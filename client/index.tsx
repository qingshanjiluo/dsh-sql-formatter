import React from 'react';
import { createSettingsCard } from '@deepseek-ai/dsh-settings';

export default createSettingsCard({
  title: 'sql-formatter',
  description: 'SQL 格式化与优化',
  config: [
    { key: 'enabled', type: 'boolean', label: '启用插件', default: true },
    { key: 'dialect', type: 'select', label: 'SQL 方言', options: ['standard', 'postgresql', 'mysql', 'sqlite'], default: 'standard' },
    { key: 'indentSize', type: 'number', label: '缩进大小', default: 2 },
  ],
});
