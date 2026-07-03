/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRAND_MODE?: 'select' | 'fixed';
  readonly VITE_DEFAULT_BRAND?: 'marcel-mellor' | 'Acme' | string;
  readonly VITE_JIRA_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
