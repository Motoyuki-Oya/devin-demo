package com.edgecell.core.redis

import com.edgecell.core.ws.CellSocket
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.runtime.StartupEvent
import jakarta.enterprise.context.ApplicationScoped
import jakarta.enterprise.event.Observes
import jakarta.inject.Inject
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.jboss.logging.Logger

@ApplicationScoped
class RedisPubSubListener {

    private val log = Logger.getLogger(RedisPubSubListener::class.java)

    @Inject
    @ConfigProperty(name = "cell.id")
    lateinit var cellId: String

    @Inject
    lateinit var redis: ReactiveRedisDataSource

    @Inject
    lateinit var cellSocket: CellSocket

    fun onStart(@Observes ev: StartupEvent) {
        val channel = "cell:$cellId:updates"
        log.info("Subscribing to Redis channel: $channel")

        redis.pubsub(ByteArray::class.java)
            .subscribe(channel) { messageBytes ->
                log.debug("Received pub/sub message (${messageBytes.size} bytes)")
                cellSocket.broadcastToLocalSessions(messageBytes)
            }
            .subscribe().with(
                { log.info("Successfully subscribed to $channel") },
                { error -> log.error("Failed to subscribe to $channel", error) }
            )
    }
}
