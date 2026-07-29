#!/usr/bin/env bash
#
# 一時的な公開デモ環境を立ち上げる。
#
# Dragonfly / backend / frontend をローカルで起動し、Cloudflare Quick Tunnel で
# 外部からアクセスできる公開URLを発行する（アカウント不要）。
# 指定時間が経過すると自動で全部停止する。
#
#   ./scripts/demo-tunnel.sh            # 2時間後に自動停止
#   TTL_HOURS=1 ./scripts/demo-tunnel.sh
#
# 必要なもの: docker, java 25, node, cloudflared
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TTL_HOURS="${TTL_HOURS:-2}"
BACKEND_PORT="${BACKEND_PORT:-8080}"
FRONTEND_PORT="${FRONTEND_PORT:-4321}"
RUN_DIR="$(mktemp -d)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

for cmd in docker java node npm cloudflared; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd が見つかりません。README の必要環境を参照してください。"
done
docker info >/dev/null 2>&1 || fail "Docker デーモンが起動していません（Docker Desktop / colima を起動してください）。"

cleanup() {
  log "停止処理中..."
  [[ -f "$RUN_DIR/pids" ]] && while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$RUN_DIR/pids"
  docker compose -f infra/docker-compose.yml down >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"
  log "停止しました。"
}
trap cleanup EXIT INT TERM

track() { echo "$1" >> "$RUN_DIR/pids"; }

# トンネルURLがログに出るまで待つ
wait_for_tunnel_url() {
  local logfile=$1 url
  for _ in $(seq 1 60); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$logfile" 2>/dev/null | head -1 || true)
    [[ -n "$url" ]] && { echo "$url"; return 0; }
    sleep 1
  done
  return 1
}

log "Dragonfly (Redis) を起動"
docker compose -f infra/docker-compose.yml up -d dragonfly >/dev/null

# フロントは接続先URLをビルド時に埋め込む必要があるため、先にトンネルを張ってURLを確定させる。
log "Cloudflare Quick Tunnel を発行"
cloudflared tunnel --url "http://localhost:${BACKEND_PORT}" --no-autoupdate > "$RUN_DIR/tunnel-backend.log" 2>&1 &
track $!
cloudflared tunnel --url "http://localhost:${FRONTEND_PORT}" --no-autoupdate > "$RUN_DIR/tunnel-frontend.log" 2>&1 &
track $!

BACKEND_URL=$(wait_for_tunnel_url "$RUN_DIR/tunnel-backend.log")  || fail "backend トンネルのURL取得に失敗"
FRONTEND_URL=$(wait_for_tunnel_url "$RUN_DIR/tunnel-frontend.log") || fail "frontend トンネルのURL取得に失敗"

log "backend を起動 (Quarkus)"
# quarkusDev は自己署名証明書で 8443、prod プロファイルは Cloudflare Origin CA 証明書を要求するため、
# トンネル利用時は独自プロファイルで TLS を無効化し、平文 HTTP をトンネルに終端させる。
(cd backend && ./gradlew build -x test -q)
EDGECELL_ALLOWED_ORIGINS="$FRONTEND_URL" \
  java -Dquarkus.profile=tunnel -Dquarkus.http.host=0.0.0.0 \
       -jar backend/build/quarkus-app/quarkus-run.jar > "$RUN_DIR/backend.log" 2>&1 &
track $!

for _ in $(seq 1 60); do
  grep -q "Listening on" "$RUN_DIR/backend.log" 2>/dev/null && break
  sleep 1
done
grep -q "Listening on" "$RUN_DIR/backend.log" || { tail -30 "$RUN_DIR/backend.log"; fail "backend の起動に失敗"; }

log "frontend をビルド (PUBLIC_BACKEND_URL=$BACKEND_URL)"
(cd frontend && npm install --silent && PUBLIC_BACKEND_URL="$BACKEND_URL" npm run build > "$RUN_DIR/frontend-build.log" 2>&1) \
  || { tail -30 "$RUN_DIR/frontend-build.log"; fail "frontend のビルドに失敗"; }

# dev サーバではなく静的配信にする（Vite は未知の Host を拒否するため、トンネル経由だと弾かれる）。
log "frontend を配信"
python3 -m http.server "$FRONTEND_PORT" --bind 0.0.0.0 --directory frontend/dist > "$RUN_DIR/frontend.log" 2>&1 &
track $!

cat <<EOS

  公開URL:  $FRONTEND_URL
  backend:  $BACKEND_URL

  認証なしのため、URL を知る人は誰でも投稿できます。
  ${TTL_HOURS} 時間後に自動停止します（Ctrl+C で即停止）。

EOS

sleep "$((TTL_HOURS * 3600))"
