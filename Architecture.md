# アーキテクチャ

## 1. 概要

このリポジトリは “EdgeCell” 風アーキテクチャのコア要素を実装しています。

- **エッジルーティング層**: Cloudflare Workers による **Sticky ルーティング**（ユーザーを決定的にバックエンド “Cell” に割り当て）。
- **Cell Core バックエンド**: **Quarkus + Kotlin** による **WebSocket エンドポイント**と、**Dragonfly（Redis互換）** を用いた軽量なセッション/オンライン状態管理。
- **インフラ補助**: docker-compose、証明書、OSネットワークチューニングスクリプト等（高同時接続実験の補助）。

リポジトリ直下の構成:

- `frontend/`
  - Astro + SolidJS + WASM によるフロントエンド。
- `backend/`
  - Quarkus（Kotlin）バックエンド（“Cell Core”）。
- `edge/router/`
  - Cloudflare Workers ルータ（Sticky ルーティングロジック）。
- `infra/`
  - Dragonfly 用 Docker Compose、証明書、チューニングスクリプト。
- `REQUIREMENTS.md`
  - 要件/狙い（スケール目標など）。

## 2. コンポーネント

### 2.1 Edge Router（Cloudflare Workers）

- **場所**
  - `edge/router/src/index.ts`
  - `edge/router/wrangler.toml`
- **責務**
  - ユーザーの “routing id” を決定し、**cell id（0-3）** に割り当てる。
  - Cookie `routing_id` により Sticky 割り当てを保持する。
  - 下流（バックエンド）で可視化できるようルーティング用ヘッダを付与する。
- **現状の挙動（実装済み）**
  - `Cookie` から `routing_id` を取得する。
  - 存在しない場合は `crypto.randomUUID()` を生成し、`Set-Cookie` で設定する。
  - `cellId = abs(hash(routing_id)) % 4` を計算する。
  - ターゲットOrigin文字列を構築する:
    - `cell-${cellId}.origin.edge-cell.com`
  - ヘッダを設定する:
    - `X-Routing-ID: <routing_id>`
    - `X-Target-Cell: <cellId>`
  - **重要**: 現状は Origin へのフォワードがスタブです（hostname 書き換えと `fetch(newRequest)` がコメントアウトされているため、デモ用テキストレスポンスを返します）。

### 2.2 Cell Core バックエンド（Quarkus + Kotlin）

- **場所**
  - `backend/`
  - WebSocket エンドポイント: `backend/src/main/kotlin/com/edgecell/core/ws/CellSocket.kt`
  - 設定: `backend/src/main/resources/application.properties`
- **技術**
  - Quarkus 3.6.x（Gradle plugin）
  - Kotlin
  - Quarkus WebSockets
  - Quarkus Redis client
- **責務**
  - WebSocket 接続の終端。
  - アクティブセッションをメモリ上で追跡。
  - 接続/切断のタイミングで Dragonfly/Redis にユーザー状態（短命）を書き込む。
- **WebSocket API**
  - エンドポイント: `GET /ws/{userId}`（WebSocket upgrade）
  - ライフサイクル:
    - `@OnOpen`: セッション追加、`user:{userId}:status = online` を設定し `EXPIRE 60`
    - `@OnClose`: セッション削除、status key 削除
    - `@OnError`: セッション削除、エラーをログ
    - `@OnMessage`: 受信内容をエコーバック（`阿部` を含む場合は特別レスポンス）
- **実行時設定**（`application.properties`）
  - HTTP port: `quarkus.http.port=8080`
  - Redis: `quarkus.redis.hosts=redis://localhost:6379`
  - Preview features:
    - `quarkus.run-java-arguments=--enable-preview`

### 2.3 データストア: Dragonfly（Redis互換）

- **場所**
  - `infra/docker-compose.yml`
- **責務**
  - オンライン状態などの一時的ステートを扱う、高スループット/低レイテンシなインメモリストア。
- **公開ポート**
  - `6379:6379`

### 2.4 インフラ補助

- **証明書**
  - `infra/certs/localhost.pem`, `infra/certs/localhost-key.pem`, `infra/certs/setup_certs.ps1`
  - ローカルTLS用途（現状、backend/worker へ直接は配線されていません）。
- **ネットワークチューニングスクリプト**
  - Linux: `infra/tuning/tune_linux.sh`
  - Windows: `infra/tuning/tune_windows.ps1`
  - エフェメラルポート、TCP TIME_WAIT、backlog、バッファ等を調整し、高同時接続を支援します。
- **TLS 終端戦略**
  - `application.properties` のプロファイルで環境ごとに切り替え:
    - **`%dev`**: Cell が自前で TLS 終端（自己署名証明書、port 8443）
    - **`%prod`**: Cloudflare が公開 TLS を終端 → Cell へは **Cloudflare Origin CA 証明書で再暗号化**
  - **暗号強度は同一**（TLS 1.3 / AES-256-GCM / ECDHE）。Cell の CPU 負荷が低い理由は:
    1. Origin CA の証明書チェーンが短い（中間 CA 1段のみ → 検証コスト低）
    2. OCSP（証明書失効確認）が不要
    3. Cloudflare が少数の長期接続を Cell に維持するため、Cell 側のハンドシェイク回数が大幅に少ない
  - Origin CA 証明書の発行: Cloudflare Dashboard → SSL/TLS → Origin Server で生成し、Cell にデプロイ

### 2.5 フロントエンド（Astro + SolidJS + WASM）

- **場所**
  - `frontend/`
- **技術**
  - Astro
  - SolidJS
  - WebAssembly（サンプル）
- **現状の挙動（最小構成）**
  - `frontend/src/pages/index.astro` がページを提供。
  - `frontend/src/components/Counter.tsx`（SolidJS）がクライアント側で動作。
  - `frontend/wasm/add.wat` を `frontend/scripts/build-wasm.mjs` でビルドし、`frontend/public/wasm/add.wasm` を生成。
  - SolidJS 側は `/wasm/add.wasm` を読み込み、WASM の `add(a,b)` を使ってカウントアップ。

## 3. 高レベルのデータフロー

### 3.1 リクエストルーティング（Edge -> Cell）

1. クライアントが Edge Router に HTTP リクエストを送る。
2. Edge Router:
   - `routing_id` cookie を読み取り、存在しなければ生成する。
   - `routing_id` から `cellId`（0-3）を計算する。
   - `X-Routing-ID` と `X-Target-Cell` ヘッダを付与する。
3. （想定動作）Edge Router が選択された Cell origin にリクエストを転送する。
4. Cell バックエンドがリクエストを処理する（WebSocket の場合は `/ws/{userId}` へ upgrade）。

### 3.2 プレゼンス/状態書き込み（Cell -> Dragonfly）

- WebSocket 接続時:
  - `SET user:{userId}:status online`
  - `EXPIRE user:{userId}:status 60`
- 切断時:
  - `DEL user:{userId}:status`

## 4. ローカル開発メモ

### 4.1 Dragonfly の起動

- `infra/docker-compose.yml` を使用して Dragonfly を起動します。

### 4.2 バックエンド（Cell Core）の実行

- バックエンドは `backend/` 配下で、Gradle + Quarkus を使用します。
- ポート `8080` で待ち受け、Dragonfly は `localhost:6379` を前提とします。

### 4.3 Edge Router（Workers）の実行

- `edge/router` は Wrangler を使用します。
- 現状の実装は実際の origin へ転送せず、割り当てられた cell を説明するテキストを返します。

### 4.4 フロントエンドの実行

- `frontend/` 配下で依存関係をインストールし、開発サーバーを起動します。

## 5. スケーリング観点（要件 vs 現状実装）

`REQUIREMENTS.md` には大規模同時接続を前提とした目標アーキテクチャが記載されています。

- **狙い（要件）**
  - ユーザーをキーにしたエッジでの Sticky ルーティング。
  - 複数の独立したバックエンド “Cell” によるシャーディング。
  - 高性能なリアルタイム層（Dragonfly）。
- **このリポジトリの現状**
  - エッジのルーティングロジックは存在し決定的だが、実転送はスタブ。
  - WebSocket + Redis（Dragonfly）連携を持つバックエンドは1つ存在。
  - 高同時接続実験を支援するインフラスクリプトが存在。

## 6. Observability 構成（デプロイ先決定後に実装）

### 6.1 アプリケーション側の準備

Quarkus Micrometer を導入し、Prometheus 互換エンドポイント (`/q/metrics`) を公開する。

- **必要な依存追加** (`build.gradle`):
  - `io.quarkus:quarkus-micrometer-registry-prometheus`
  - または OpenTelemetry 経由: `io.quarkus:quarkus-opentelemetry`

- **カスタムメトリクス（SLO 監視に必要）**:
  - `edgecell_ws_connections_active` — アクティブ接続数（Gauge）
  - `edgecell_ws_messages_received_total` — 受信メッセージ数（Counter）
  - `edgecell_ws_messages_sent_total` — 送信メッセージ数（Counter）
  - `edgecell_ws_message_latency_seconds` — メッセージ処理レイテンシ（Histogram）
  - `edgecell_redis_command_latency_seconds` — Redis コマンドレイテンシ（Histogram）

### 6.2 クラウドプラットフォーム別の構成

#### AWS

- **CloudWatch Container Insights** + CloudWatch Agent で Prometheus エンドポイントをスクレイプ。
- ECS/EKS いずれでも利用可能。
- AWS Distro for OpenTelemetry (ADOT) Collector を使う方法も推奨。

#### Azure

- **Azure Monitor** + **Application Insights** (OpenTelemetry 経由)。
- `quarkus-opentelemetry` エクステンションで OTLP エクスポートし、Azure Monitor が受信。
