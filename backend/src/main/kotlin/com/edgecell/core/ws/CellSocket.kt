package com.edgecell.core.ws

import com.edgecell.proto.Messages
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import org.eclipse.microprofile.config.inject.ConfigProperty
import jakarta.websocket.*
import jakarta.websocket.server.PathParam
import jakarta.websocket.server.ServerEndpoint
import org.jboss.logging.Logger
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@ServerEndpoint("/ws/{userId}", configurator = WsOriginConfigurator::class)
@ApplicationScoped
class CellSocket {

    companion object {
        private val log = Logger.getLogger(CellSocket::class.java)
        // userId → Session。ターゲット送信・重複接続検知・接続数カウントに対応。
        private val sessions = ConcurrentHashMap<String, Session>()

        // Redis キー(user:{userId}:status 等)とログに直接埋め込むため、書式を制限する
        private val USER_ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
        private const val STATUS_TTL_SECONDS = 60L

        // 掲示板: 保持する最新投稿数と入力上限（メモリ/帯域の保護）
        private const val MAX_POSTS = 100L
        private const val MAX_AUTHOR_LEN = 50
        private const val MAX_CONTENT_LEN = 500
    }

    @Inject
    @ConfigProperty(name = "cell.id")
    lateinit var cellId: String

    @Inject
    lateinit var redis: ReactiveRedisDataSource

    private fun postsKey() = "cell:$cellId:posts"

    @OnOpen
    fun onOpen(session: Session, @PathParam("userId") userId: String) {
        if (!USER_ID_PATTERN.matches(userId)) {
            log.warn("Rejected connection: invalid userId format")
            session.close(CloseReason(CloseReason.CloseCodes.CANNOT_ACCEPT, "invalid user id"))
            return
        }

        val previous = sessions.put(userId, session)
        if (previous != null && previous !== session && previous.isOpen) {
            // 同一 userId の重複接続: 古いセッションを閉じて新しい接続を優先する
            try {
                previous.close(CloseReason(CloseReason.CloseCodes.NORMAL_CLOSURE, "superseded by new connection"))
            } catch (e: Exception) {
                log.debug("Failed to close superseded session for $userId", e)
            }
        }
        log.info("User connected: $userId to $cellId (active=${sessions.size})")

        redis.value(String::class.java)
            .setex("user:$userId:status", STATUS_TTL_SECONDS, "online")
            .subscribe().with(
                { log.debug("Set status key for user $userId") },
                { error -> log.warn("Failed to set status key for user $userId (non-fatal)", error) }
            )

        // 接続時に既存の投稿一覧（新しい順）を送る
        sendPostList(session, userId)
    }

    @OnClose
    fun onClose(session: Session, @PathParam("userId") userId: String) {
        // 重複接続で置き換えられた古いセッションの close では、新しい接続の状態を消さない
        if (!sessions.remove(userId, session)) {
            log.debug("Stale session closed for user $userId (already superseded)")
            return
        }
        redis.key().del("user:$userId:status").subscribe().with(
            { log.debug("Deleted status key for user $userId") },
            { error -> log.warn("Failed to delete status key for user $userId (non-fatal)", error) }
        )
        redis.key().del("user:$userId:location").subscribe().with(
            { log.debug("Deleted location key for user $userId") },
            { error -> log.warn("Failed to delete location key for user $userId (non-fatal)", error) }
        )
        log.info("User disconnected: $userId (active=${sessions.size})")
    }

    @OnError
    fun onError(session: Session, @PathParam("userId") userId: String, throwable: Throwable) {
        sessions.remove(userId, session)
        log.error("Socket error for user $userId", throwable)
    }

    @OnMessage
    fun onMessage(buffer: ByteBuffer, session: Session) {
        try {
            // ByteBuffer から直接パースする: backing array のコピーを避け、
            // buffer.array() が offset を無視する問題も回避する
            val clientMessage = Messages.ClientMessage.parseFrom(buffer)

            when {
                clientMessage.hasCreatePost() -> handleCreatePost(clientMessage.createPost, session)
                clientMessage.hasIncrement() -> handleIncrement()
            }
        } catch (e: Exception) {
            log.error("Failed to parse Protobuf message", e)
        }
    }

    /**
     * 接続中セッションへ既存投稿一覧を送信する。
     * Redis の LIST は LPUSH で先頭に積むため、LRANGE の結果は既に「新しい順」。
     */
    private fun sendPostList(session: Session, userId: String) {
        redis.list(ByteArray::class.java).lrange(postsKey(), 0, MAX_POSTS - 1)
            .subscribe().with(
                { rows ->
                    val postListBuilder = Messages.PostList.newBuilder()
                    rows.forEach { bytes ->
                        try {
                            postListBuilder.addPosts(Messages.Post.parseFrom(bytes))
                        } catch (e: Exception) {
                            log.warn("Skipping malformed post in Redis list", e)
                        }
                    }
                    val serverMessage = Messages.ServerMessage.newBuilder()
                        .setPostList(postListBuilder.build())
                        .build()
                    session.asyncRemote.sendBinary(ByteBuffer.wrap(serverMessage.toByteArray()))
                },
                { error ->
                    log.warn("Redis LRANGE failed for user $userId on connect, sending empty list", error)
                    // Degraded operation (REQUIREMENTS 3.4): Redis 不通時は空一覧を返す
                    val fallback = Messages.ServerMessage.newBuilder()
                        .setPostList(Messages.PostList.getDefaultInstance())
                        .build()
                    session.asyncRemote.sendBinary(ByteBuffer.wrap(fallback.toByteArray()))
                }
            )
    }

    /**
     * 新規投稿を受け付け、Redis に永続化してから pub/sub で全 Cell のクライアントへ配信する。
     */
    private fun handleCreatePost(req: Messages.CreatePostRequest, session: Session) {
        val author = req.author.trim().take(MAX_AUTHOR_LEN).ifBlank { "名無しさん" }
        val content = req.content.trim().take(MAX_CONTENT_LEN)
        if (content.isEmpty()) {
            log.debug("Ignored empty post from $cellId")
            return
        }

        val post = Messages.Post.newBuilder()
            .setId(UUID.randomUUID().toString())
            .setAuthor(author)
            .setContent(content)
            .setCellId(cellId)
            .setTimestamp(System.currentTimeMillis())
            .build()

        val postBytes = post.toByteArray()

        // LPUSH で先頭に積み、LTRIM で最新 MAX_POSTS 件に切り詰める
        redis.list(ByteArray::class.java).lpush(postsKey(), postBytes)
            .flatMap { redis.list(ByteArray::class.java).ltrim(postsKey(), 0, MAX_POSTS - 1) }
            .subscribe().with(
                {
                    val serverMessage = Messages.ServerMessage.newBuilder()
                        .setPostAdded(post)
                        .build()
                    redis.pubsub(ByteArray::class.java)
                        .publish("cell:$cellId:updates", serverMessage.toByteArray())
                        .subscribe().with(
                            { log.debug("Published new post to Redis") },
                            { error -> log.error("Failed to publish post to Redis", error) }
                        )
                },
                { error -> log.error("Redis LPUSH/LTRIM failed for posts on $cellId", error) }
            )
    }

    private fun handleIncrement() {
        redis.value(Long::class.java).incr("cell:$cellId:counter")
            .subscribe().with(
                { newValue ->
                    val counterUpdate = Messages.CounterUpdate.newBuilder()
                        .setValue(newValue)
                        .setCellId(cellId)
                        .setTimestamp(System.currentTimeMillis())
                        .build()

                    val serverMessage = Messages.ServerMessage.newBuilder()
                        .setCounterUpdate(counterUpdate)
                        .build()

                    val messageBytes = serverMessage.toByteArray()
                    redis.pubsub(ByteArray::class.java)
                        .publish("cell:$cellId:updates", messageBytes)
                        .subscribe().with(
                            { log.debug("Published counter update to Redis") },
                            { error -> log.error("Failed to publish to Redis", error) }
                        )
                },
                { error ->
                    log.error("Redis INCR failed for cell $cellId counter", error)
                }
            )
    }

    /**
     * Broadcast binary message to all local WebSocket sessions.
     * Called by RedisPubSubListener when receiving pub/sub messages.
     *
     * NOTE(production): デモ用の O(N) 全走査ブロードキャスト。
     *   本番アプリではブロードキャストを使わず、userId に基づくターゲット送信を実装すること。
     *   ブロードキャストが必要な場合はセグメント化（グループ分け）やバッチ送信で負荷を軽減すること。
     */
    fun broadcastToLocalSessions(messageBytes: ByteArray) {
        sessions.values.forEach { s ->
            if (s.isOpen) {
                try {
                    s.asyncRemote.sendBinary(ByteBuffer.wrap(messageBytes))
                } catch (e: Exception) {
                    log.error("Broadcast error", e)
                }
            }
        }
    }
}
