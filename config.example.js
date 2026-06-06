/**
 * Скопируйте в config.js и подставьте ключи из Supabase → Project Settings → API.
 * config.js не коммитится в git.
 *
 * GitHub Pages: ключи задаются как Secrets SUPABASE_URL и SUPABASE_ANON_KEY
 * (см. .github/workflows/deploy.yml). Без config.js на сервере синхронизация не работает.
 */
const CST_CONFIG = {
    supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
    supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
    syncEnabled: true,
};
