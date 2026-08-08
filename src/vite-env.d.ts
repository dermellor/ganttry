/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JIRA_BASE_URL?: string;
  /** Base path of this instance's build output, e.g. "/data" or "/data-test". */
  readonly VITE_DATA_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
