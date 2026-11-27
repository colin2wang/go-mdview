import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'bindings/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['src/**/*.{ts,vue}', 'src/**/*.js', 'scripts/**/*.mjs', '*.ts', '*.mjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      // 生成的绑定与少量外部库入口仍用 any；这里只管风格问题，类型交给 vue-tsc。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // CJK 正则里包含全角空格（U+3000），属于有意字符范围。
      'no-irregular-whitespace': 'off',
      // 既有组件名是单文件语义命名（Viewer / TitleBar 等），不强制多单词。
      'vue/multi-word-component-names': 'off',
      // 查找框的 Enter / Shift+Enter 是叠加关系，不能用 .exact 覆盖。
      'vue/use-v-on-exact': 'off'
    }
  },
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser }
    }
  }
)
