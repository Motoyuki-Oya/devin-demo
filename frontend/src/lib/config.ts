/**
 * バックエンドの接続先。
 *
 * `PUBLIC_BACKEND_URL` を指定するとそちらを使う（トンネル経由や別ホストへのデプロイ時）。
 * 未指定ならローカル開発用の https://localhost:8443 にフォールバックする。
 * transport 側で https -> wss / http -> ws に変換される。
 */
const DEFAULT_BACKEND_URL = 'https://localhost:8443';

export const BACKEND_URL: string =
    import.meta.env.PUBLIC_BACKEND_URL?.replace(/\/$/, '') || DEFAULT_BACKEND_URL;
