/**
 * Скопируйте в config.js и подставьте ключи из Supabase → Project Settings → API.
 * config.js не коммитится в git (на GitHub создаётся Actions из Secrets).
 */
window.CST_CONFIG = {
    supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
    supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
    syncEnabled: true,
};
