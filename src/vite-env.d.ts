/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASHLER_LLM_KEY?: string;
  readonly VITE_BASHLER_LLM_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
