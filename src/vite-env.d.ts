/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASHER_LLM_KEY?: string;
  readonly VITE_BASHER_LLM_BASE_URL?: string;
  readonly VITE_BASHER_LLM_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
