---
name: public-demo
description: devin-demo 掲示板を一時的な公開URLで動かして、ユーザーがブラウザから直接触れるようにする。ローカル環境（Docker/JDK）を用意できない相手にデモ・動作確認してもらう時に使う。
---

# 一時公開デモ環境を立てる

ユーザーが「動作確認したい」「外部から接続したい」「一時的な環境を作って」と言った時に使う。
Devin の VM の localhost は外部から到達できないため、Cloudflare Quick Tunnel（アカウント不要・無料）で公開する。

## 使い方

```sh
./scripts/demo-tunnel.sh          # 2時間後に自動停止
TTL_HOURS=1 ./scripts/demo-tunnel.sh
```

スクリプトが公開URLを表示するので、それをユーザーに伝える。**認証なしの掲示板なので、URLを知る人は誰でも投稿できる点を必ず添えること。**

`cloudflared` が未インストールなら先に入れる:

```sh
curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
```

## 引き渡す前に必ず疎通確認する

壊れたURLを渡さないため、ブラウザで公開URLを開き、以下を確認してから伝える。

1. 接続状態が緑の「● 接続中」になっている（WebSocket 確立の証明）
2. 実際に1件投稿し、一覧に表示される（WS → Redis → ブロードキャストの往復確認）

## このプロジェクト固有のハマりどころ

スクリプトは以下を織り込み済み。手動で組む場合も同じ対処が要る。

- **フロントの接続先はビルド時に埋め込まれる**: `PUBLIC_BACKEND_URL` は Astro が build 時にバンドルへ焼き込む。したがって **トンネルURLを先に確定させてから frontend をビルドする**。順序を逆にすると `https://localhost:8443` のままになり接続できない。
- **トンネルは2本必要**: frontend(4321) と backend(8080) はポートが別。Quick Tunnel は1本1ポート。
- **backend は HTTP ポート(8080)側にトンネルする**: 8443 は自己署名証明書のため。TLS はトンネル側が終端し、`https://` は `transport.ts` が `wss://` に変換する。
- **プロファイルは `-Dquarkus.profile=tunnel`**: `%dev` は自己署名証明書で 8443、`%prod` は `/etc/edgecell/certs/origin-cert.pem`（存在しない）を要求して起動に失敗する。独自プロファイル名にすればどちらの SSL 設定も効かず、平文 8080 のみで起動する。
- **Origin 許可リストに公開元を追加する**: WebSocket handshake は `edgecell.allowed-origins` で Origin を検証する（CSWSH 対策）。`EDGECELL_ALLOWED_ORIGINS=<frontendの公開URL>` を渡さないと handshake が弾かれる。
- **frontend は dev サーバでなく静的配信にする**: Vite/Astro dev サーバは未知の Host ヘッダを拒否するため、トンネル経由だとブロックされる。`npm run build` の成果物を静的配信する。
- **`quarkusDev` は依存解決で失敗しうる**: Dev UI 用に大量の依存を取りにいき、Maven Central が 429 を返すことがある。デモ用途では `./gradlew build -x test` + `java -jar build/quarkus-app/quarkus-run.jar` の方が安定する。

## 後片付け

スクリプトは TTL 経過・Ctrl+C・異常終了のいずれでも trap で全プロセスと Dragonfly を停止する。
別途手動で止める場合:

```sh
pkill -f cloudflared; pkill -f quarkus-run.jar; pkill -f "http.server 4321"
docker compose -f infra/docker-compose.yml down
```
