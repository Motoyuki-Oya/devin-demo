# devin-demo 掲示板

投稿した内容がリアルタイムで全員に表示される、認証なしの簡易掲示板です。
Devin をデモするためのベースプロジェクトとして、**単体で動作**するよう最小構成にしてあります。

- **バックエンド**: Node.js + [Express](https://expressjs.com/)（REST API）+ [ws](https://github.com/websockets/ws)（WebSocket リアルタイム配信）
- **フロントエンド**: 素の HTML / CSS / JavaScript（ビルド不要）
- **ストレージ**: インメモリ（最新100件）。外部サービス（DB / Redis 等）は不要。

## 必要環境

- Node.js 18 以上

## 起動

```sh
npm install
npm start
```

起動後、ブラウザで http://localhost:3000 を開きます。
（ポートを変える場合は `PORT=8080 npm start`）

開発時はファイル変更で自動再起動する `npm run dev` も使えます。

## 仕組み

```
ブラウザ ──POST /api/posts──▶ Express ──▶ ストア(store.js)へ追加
                                     │
                                     └─▶ 全 WebSocket クライアントへ post_added を配信
ブラウザ ◀── WebSocket /ws ── 接続直後に post_list（既存一覧）を受信
```

- `GET /api/posts` … 投稿一覧（新しい順）を JSON で返す
- `POST /api/posts` … `{ "author": "名前", "content": "本文" }` を受け取り投稿を作成
- `WebSocket /ws` … 接続時に `post_list`、新規投稿時に `post_added` を受信

## ファイル構成

```
devin-demo/
├── server.js          # Express + WebSocket サーバ
├── src/store.js       # 投稿ストア（インメモリ / 拡張ポイント）
├── public/
│   ├── index.html     # 画面
│   ├── styles.css     # スタイル
│   └── app.js         # フロントエンドロジック（WS購読・投稿）
└── package.json
```

## 拡張のヒント

- **永続化**: `src/store.js` の `listPosts` / `createPost` を DB や JSON ファイル実装に差し替える。
- **削除・編集・いいね**: `server.js` に API を追加し、WebSocket メッセージ種別を増やす。
- **認証**: 投稿 API にミドルウェアを挟む。
