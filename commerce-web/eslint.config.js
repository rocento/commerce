import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-server/**', '**/.next/**', '**/out/**', '**/node_modules/**', 'apps/website/public/docs/api/reference/vendor/**', 'apps/admin/public/api-reference/vendor/**', 'apps/mobile-admin/public/maps/map.js', 'packages/api-client/src/mobile-validator.generated.js', 'playwright-report/**', 'test-results/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx}'], plugins: { 'react-hooks': hooks }, rules: hooks.configs.recommended.rules },
);
