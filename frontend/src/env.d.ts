/// <reference types="astro/client" />

interface ImportMetaEnv {
    /** バックエンドのベースURL（未指定なら https://localhost:8443） */
    readonly PUBLIC_BACKEND_URL?: string;
}
