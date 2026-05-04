/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRAND_MODE?: 'select' | 'fixed';
  readonly VITE_DEFAULT_BRAND?: 'marcel-mellor' | 'Acme' | string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
