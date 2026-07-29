package com.edgecell.core.ws

import com.edgecell.proto.Messages
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.smallrye.mutiny.Uni
import io.smallrye.mutiny.infrastructure.Infrastructure
import io.vertx.mutiny.redis.client.Redis
import io.vertx.mutiny.redis.client.Request
import io.vertx.mutiny.redis.client.Command
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import org.eclipse.microprofile.config.inject.ConfigProperty
import jakarta.websocket.*
import jakarta.websocket.server.PathParam
import jakarta.websocket.server.ServerEndpoint
import org.jboss.logging.Logger
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

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

        private const val DEFAULT_AUTHOR = "名無しさん"

        // リアクション: フロントのパレットと一致させる。許可リスト外は破棄する（任意の文字列で
        // ハッシュのフィールドを増やされるのを防ぐ）。
        private val ALLOWED_EMOJIS = setOf("👍", "😂", "😢", "🎉", "❤️", "🙏")

        // 1 投稿あたりのリアクション数（絵文字 × 人数）の上限
        private const val MAX_REACTIONS_PER_POST = 500L

        // 投稿は LTRIM で一覧から溢れるが、リアクションは別キーなので TTL で回収する
        private const val REACTION_TTL_SECONDS = 60L * 60 * 24 * 30

        private val POST_ID_PATTERN = Regex("^[A-Za-z0-9-]{1,64}$")

        // ハッシュのフィールドは "{emoji}\n{author}"。author から改行を除くことで一意に分解できる。
        private const val FIELD_SEPARATOR = '\n'

        // 編集用パスワード。平文は保存せず、投稿とは別キーに PBKDF2 のハッシュだけを置く。
        private const val MAX_PASSWORD_LEN = 128
        private const val PBKDF2_ITERATIONS = 100_000
        private const val PBKDF2_KEY_BITS = 256
        private const val SALT_BYTES = 16
        private val secureRandom = SecureRandom()

        // LIST は id で直接引けないため、添字の探索と LSET を 1 つの Lua スクリプトにまとめて
        // 原子的に行う。別リクエストの LPUSH で添字がずれても他の投稿を上書きしない。
        private const val LSET_BY_ID_SCRIPT = """
            local len = redis.call('LLEN', KEYS[1])
            for i = 0, len - 1 do
              local row = redis.call('LINDEX', KEYS[1], i)
              if row and string.sub(row, 1, #ARGV[1]) == ARGV[1] then
                redis.call('LSET', KEYS[1], i, ARGV[2])
                return 1
              end
            end
            return 0
        """
    }

    @Inject
    @ConfigProperty(name = "cell.id")
    lateinit var cellId: String

    @Inject
    lateinit var redis: ReactiveRedisDataSource

    // Lua スクリプトへ protobuf のバイト列をそのまま渡すため、バイナリ安全な低レベル
    // クライアントを使う（ReactiveRedisDataSource は EVAL の引数を文字列しか取れない）。
    @Inject
    lateinit var redisClient: Redis

    private fun postsKey() = "cell:$cellId:posts"

    private fun reactionsKey(postId: String) = "cell:$cellId:post:$postId:reactions"

    private fun authKey(postId: String) = "cell:$cellId:post:$postId:auth"

    /** 名前は識別子として使うため、投稿とリアクションで同じ正規化を通す。 */
    private fun sanitizeAuthor(raw: String): String =
        raw.trim()
            .filter { !it.isISOControl() }
            .take(MAX_AUTHOR_LEN)
            .ifBlank { DEFAULT_AUTHOR }

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
                clientMessage.hasToggleReaction() -> handleToggleReaction(clientMessage.toggleReaction)
                clientMessage.hasEditPost() -> handleEditPost(clientMessage.editPost, session)
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
                    val posts = rows.mapNotNull { bytes -> parsePost(bytes) }
                    attachReactions(posts).subscribe().with(
                        { withReactions ->
                            val serverMessage = Messages.ServerMessage.newBuilder()
                                .setPostList(Messages.PostList.newBuilder().addAllPosts(withReactions))
                                .build()
                            session.asyncRemote.sendBinary(ByteBuffer.wrap(serverMessage.toByteArray()))
                        },
                        { error ->
                            log.warn("Failed to load reactions for user $userId, sending posts without them", error)
                            val serverMessage = Messages.ServerMessage.newBuilder()
                                .setPostList(Messages.PostList.newBuilder().addAllPosts(posts))
                                .build()
                            session.asyncRemote.sendBinary(ByteBuffer.wrap(serverMessage.toByteArray()))
                        }
                    )
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

    /** 各投稿に Redis 上のリアクションを載せて返す。 */
    private fun attachReactions(posts: List<Messages.Post>): Uni<List<Messages.Post>> {
        if (posts.isEmpty()) return Uni.createFrom().item(emptyList())
        val unis = posts.map { post ->
            reactionsOf(post.id).map { reactions -> post.toBuilder().addAllReactions(reactions).build() }
        }
        return Uni.join().all(unis).andFailFast()
    }

    /**
     * リアクションは 1 投稿 = 1 ハッシュで保持し、フィールドを "{emoji}\n{author}" にする。
     * 付け外しが単一フィールドの追加/削除になるため、read-modify-write の競合を避けられる。
     */
    private fun reactionsOf(postId: String): Uni<List<Messages.Reaction>> =
        redis.hash(String::class.java).hgetall(reactionsKey(postId))
            .map { fields -> groupReactions(fields.keys) }
            .onFailure().recoverWithItem { error ->
                log.warnf("Failed to read reactions for post %s (non-fatal): %s", postId, error.message)
                emptyList()
            }

    /** 表示順を安定させるため、絵文字はパレットの並び順に揃える。 */
    private fun groupReactions(fields: Set<String>): List<Messages.Reaction> {
        val byEmoji = fields.mapNotNull { field ->
            val separator = field.indexOf(FIELD_SEPARATOR)
            if (separator <= 0) null else field.substring(0, separator) to field.substring(separator + 1)
        }.groupBy({ it.first }, { it.second })

        return ALLOWED_EMOJIS.mapNotNull { emoji ->
            val authors = byEmoji[emoji] ?: return@mapNotNull null
            Messages.Reaction.newBuilder()
                .setEmoji(emoji)
                .addAllAuthors(authors.sorted())
                .build()
        }
    }

    /**
     * リアクションを付け外しする。まず HDEL を試し、消せなかった場合のみ追加する（同じ
     * 名前で同じ絵文字を再送すると解除される = トグル）。
     */
    private fun handleToggleReaction(req: Messages.ToggleReactionRequest) {
        val postId = req.postId
        val emoji = req.emoji
        if (!POST_ID_PATTERN.matches(postId)) {
            log.warn("Rejected reaction: invalid postId format")
            return
        }
        if (emoji !in ALLOWED_EMOJIS) {
            log.warn("Rejected reaction: emoji not in allowlist")
            return
        }

        val key = reactionsKey(postId)
        val field = "$emoji$FIELD_SEPARATOR${sanitizeAuthor(req.author)}"
        val hash = redis.hash(String::class.java)

        hash.hdel(key, field)
            .flatMap { removed ->
                if (removed > 0) Uni.createFrom().item(true)
                // 上限に達している場合は解除のみ許可し、追加は無視する
                else hash.hlen(key).flatMap { size ->
                    if (size >= MAX_REACTIONS_PER_POST) Uni.createFrom().item(false)
                    else hash.hsetnx(key, field, "1")
                        .flatMap { redis.key().expire(key, REACTION_TTL_SECONDS) }
                }
            }
            .flatMap { reactionsOf(postId) }
            .subscribe().with(
                { reactions ->
                    val serverMessage = Messages.ServerMessage.newBuilder()
                        .setReactionUpdate(
                            Messages.ReactionUpdate.newBuilder()
                                .setPostId(postId)
                                .addAllReactions(reactions)
                        )
                        .build()
                    redis.pubsub(ByteArray::class.java)
                        .publish("cell:$cellId:updates", serverMessage.toByteArray())
                        .subscribe().with(
                            { log.debug("Published reaction update to Redis") },
                            { error -> log.error("Failed to publish reaction update to Redis", error) }
                        )
                },
                { error -> log.error("Redis reaction toggle failed for post $postId", error) }
            )
    }

    /**
     * 新規投稿を受け付け、Redis に永続化してから pub/sub で全 Cell のクライアントへ配信する。
     */
    private fun handleCreatePost(req: Messages.CreatePostRequest, session: Session) {
        val author = sanitizeAuthor(req.author)
        val content = req.content.trim().take(MAX_CONTENT_LEN)
        if (content.isEmpty()) {
            log.debug("Ignored empty post from $cellId")
            return
        }

        val password = req.password.take(MAX_PASSWORD_LEN)
        val post = Messages.Post.newBuilder()
            .setId(UUID.randomUUID().toString())
            .setAuthor(author)
            .setContent(content)
            .setCellId(cellId)
            .setTimestamp(System.currentTimeMillis())
            .setEditable(password.isNotEmpty())
            .build()

        val postBytes = post.toByteArray()

        // パスワードは投稿本体と別キーに保存する。Post はそのまま全クライアントに
        // 配信されるため、ハッシュを含めてもクライアントに漏れてはいけない。
        val storeAuth: Uni<Void> =
            if (password.isEmpty()) Uni.createFrom().voidItem()
            else hashPassword(password).flatMap { encoded ->
                // 投稿本体と同じく TTL は付けない。先に失効すると「編集」ボタンは出るのに
                // 正しいパスワードでも編集できない投稿になる。
                redis.value(String::class.java).set(authKey(post.id), encoded)
            }

        // LPUSH で先頭に積み、LTRIM で最新 MAX_POSTS 件に切り詰める
        storeAuth
            .flatMap { redis.list(ByteArray::class.java).lpush(postsKey(), postBytes) }
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

    /**
     * 投稿本文を編集する。投稿時にパスワードを設定していない投稿は編集できない。
     * 成否は要求元のセッションにだけ返し、成功時の最新内容は pub/sub で全体に配信する。
     */
    private fun handleEditPost(req: Messages.EditPostRequest, session: Session) {
        val postId = req.postId
        if (!POST_ID_PATTERN.matches(postId)) {
            log.warn("Rejected edit: invalid postId format")
            return
        }
        val content = req.content.trim().take(MAX_CONTENT_LEN)
        if (content.isEmpty()) {
            sendEditResult(session, postId, false, "本文を入力してください")
            return
        }

        redis.value(String::class.java).get(authKey(postId))
            .flatMap { encoded ->
                if (encoded.isNullOrEmpty()) Uni.createFrom().item(false)
                else verifyPassword(req.password.take(MAX_PASSWORD_LEN), encoded)
            }
            .flatMap { authorized ->
                if (!authorized) Uni.createFrom().nullItem<Messages.Post?>()
                else replacePostContent(postId, content)
            }
            .subscribe().with(
                { updated ->
                    when {
                        // パスワード不一致 / 編集不可 / 投稿なし を区別しない（総当たりのヒントを与えない）
                        updated == null ->
                            sendEditResult(session, postId, false, "編集できませんでした")
                        else -> {
                            sendEditResult(session, postId, true, "")
                            val serverMessage = Messages.ServerMessage.newBuilder()
                                .setPostUpdated(updated)
                                .build()
                            redis.pubsub(ByteArray::class.java)
                                .publish("cell:$cellId:updates", serverMessage.toByteArray())
                                .subscribe().with(
                                    { log.debug("Published post update to Redis") },
                                    { error -> log.error("Failed to publish post update to Redis", error) }
                                )
                        }
                    }
                },
                { error ->
                    log.error("Edit failed for post $postId", error)
                    sendEditResult(session, postId, false, "編集できませんでした")
                }
            )
    }

    /**
     * LIST 内の該当投稿を本文を差し替えたもので上書きする。存在しなければ null。
     * 差し替え先の特定と書き込みは Lua スクリプト内で行うため、同時投稿で添字がずれても
     * 別の投稿を上書きすることはない。
     */
    private fun replacePostContent(postId: String, content: String): Uni<Messages.Post?> =
        redis.list(ByteArray::class.java).lrange(postsKey(), 0, MAX_POSTS - 1).flatMap { rows ->
            val post = rows.asSequence()
                .mapNotNull { bytes -> parsePost(bytes) }
                .firstOrNull { it.id == postId }
                ?: return@flatMap Uni.createFrom().nullItem<Messages.Post?>()

            val updated = post.toBuilder()
                .setContent(content)
                .setEditedAt(System.currentTimeMillis())
                .build()

            lsetById(postId, updated.toByteArray()).flatMap { replaced ->
                if (!replaced) Uni.createFrom().nullItem()
                else reactionsOf(postId)
                    .map { reactions -> updated.toBuilder().addAllReactions(reactions).build() }
            }
        }

    /** LIST から id が一致する要素を探して差し替える。見つからなければ false。 */
    private fun lsetById(postId: String, value: ByteArray): Uni<Boolean> {
        val request = Request.cmd(Command.EVAL)
            .arg(LSET_BY_ID_SCRIPT)
            .arg(1)
            .arg(postsKey())
            .arg(idFieldPrefix(postId))
            .arg(value)
        return redisClient.send(request).map { response -> response?.toInteger() == 1 }
    }

    /**
     * Post の protobuf は field 1 (id) が先頭に並ぶため、"tag + 長さ + id" が前方一致すれば
     * その要素が該当投稿。id は 64 文字以内なので長さは 1 バイトに収まる。
     */
    private fun idFieldPrefix(postId: String): ByteArray {
        val idBytes = postId.toByteArray(StandardCharsets.UTF_8)
        return byteArrayOf(0x0A, idBytes.size.toByte()) + idBytes
    }

    private fun parsePost(bytes: ByteArray): Messages.Post? =
        try {
            Messages.Post.parseFrom(bytes)
        } catch (e: Exception) {
            log.warn("Skipping malformed post in Redis list", e)
            null
        }

    private fun sendEditResult(session: Session, postId: String, ok: Boolean, message: String) {
        if (!session.isOpen) return
        val serverMessage = Messages.ServerMessage.newBuilder()
            .setEditResult(
                Messages.EditResult.newBuilder()
                    .setPostId(postId)
                    .setOk(ok)
                    .setMessage(message)
            )
            .build()
        session.asyncRemote.sendBinary(ByteBuffer.wrap(serverMessage.toByteArray()))
    }

    /** 形式: "{iterations}:{saltBase64}:{hashBase64}" */
    private fun hashPassword(password: String): Uni<String> =
        Uni.createFrom().item {
            val salt = ByteArray(SALT_BYTES).also { secureRandom.nextBytes(it) }
            val hash = pbkdf2(password, salt, PBKDF2_ITERATIONS)
            val encoder = Base64.getEncoder()
            "$PBKDF2_ITERATIONS:${encoder.encodeToString(salt)}:${encoder.encodeToString(hash)}"
        }.runSubscriptionOn(Infrastructure.getDefaultWorkerPool())

    private fun verifyPassword(password: String, encoded: String): Uni<Boolean> =
        Uni.createFrom().item {
            val parts = encoded.split(':')
            if (parts.size != 3) {
                log.warn("Malformed password hash, treating as unverifiable")
                return@item false
            }
            val iterations = parts[0].toIntOrNull() ?: return@item false
            val decoder = Base64.getDecoder()
            val salt = decoder.decode(parts[1])
            val expected = decoder.decode(parts[2])
            MessageDigest.isEqual(expected, pbkdf2(password, salt, iterations))
        }.runSubscriptionOn(Infrastructure.getDefaultWorkerPool())

    /** PBKDF2 は意図的に重いので、必ずワーカースレッド上で呼ぶ（イベントループを塞げない）。 */
    private fun pbkdf2(password: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(password.toCharArray(), salt, iterations, PBKDF2_KEY_BITS)
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
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
