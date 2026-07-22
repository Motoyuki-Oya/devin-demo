package com.edgecell.core.ws

import jakarta.websocket.server.ServerEndpointConfig
import org.eclipse.microprofile.config.ConfigProvider
import org.jboss.logging.Logger

/**
 * Cross-Site WebSocket Hijacking (CSWSH) 対策。
 * ブラウザが送る Origin ヘッダを許可リスト(edgecell.allowed-origins)と照合する。
 *
 * Origin ヘッダなしの handshake は許可する:
 * 負荷試験ツール等の非ブラウザクライアントは Origin を送らず、
 * CSWSH はブラウザの Cookie 自動送信を悪用する攻撃のため非ブラウザは対象外。
 */
class WsOriginConfigurator : ServerEndpointConfig.Configurator() {

    companion object {
        private val log = Logger.getLogger(WsOriginConfigurator::class.java)

        private val allowedOrigins: Set<String> by lazy {
            ConfigProvider.getConfig()
                .getOptionalValue("edgecell.allowed-origins", String::class.java)
                .orElse("*")
                .split(",")
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .toSet()
        }
    }

    override fun checkOrigin(originHeaderValue: String?): Boolean {
        if (originHeaderValue.isNullOrEmpty()) return true
        if ("*" in allowedOrigins) return true
        val allowed = originHeaderValue in allowedOrigins
        if (!allowed) {
            log.warnf("Rejected WebSocket handshake from disallowed origin: %s", originHeaderValue)
        }
        return allowed
    }
}
