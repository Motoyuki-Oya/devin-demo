import { ClientMessage, ServerMessage, IncrementRequest, CounterUpdate } from './proto';

/**
 * Transport options for EdgeCellTransport
 */
export interface TransportOptions {
    /** Base URL (e.g., 'https://localhost:8443') */
    url: string;
    /** User ID for this connection */
    userId: string;
    /** Prefer WebTransport over WebSocket (auto-fallback if unsupported) */
    preferWebTransport?: boolean;
    /** Called when connection is established */
    onConnect?: () => void;
    /** Called when connection is closed */
    onDisconnect?: () => void;
    /** Called on error */
    onError?: (error: Error) => void;
    /** Reconnect automatically on disconnect */
    autoReconnect?: boolean;
    /** Base reconnect delay in ms (grows exponentially with jitter, capped at maxReconnectDelay) */
    reconnectDelay?: number;
    /** Maximum reconnect delay in ms */
    maxReconnectDelay?: number;
}

/**
 * Transport protocol type
 */
export type TransportProtocol = 'websocket' | 'webtransport';

/**
 * EdgeCellTransport - Unified transport abstraction with automatic fallback
 * 
 * Supports WebTransport (Chrome/Firefox) with automatic fallback to WebSocket (Safari).
 * Provides a unified API regardless of underlying protocol.
 */
export class EdgeCellTransport {
    private ws: WebSocket | null = null;
    private protocol: TransportProtocol = 'websocket';
    private options: Required<TransportOptions>;
    private messageHandlers: Set<(data: ArrayBuffer) => void> = new Set();
    private reconnectTimer: number | null = null;
    private reconnectAttempts = 0;
    private intentionallyClosed = false;

    constructor(options: TransportOptions) {
        this.options = {
            preferWebTransport: false,
            onConnect: () => { },
            onDisconnect: () => { },
            onError: () => { },
            autoReconnect: true,
            reconnectDelay: 1000,
            maxReconnectDelay: 30000,
            ...options,
        };

        this.connect();
    }

    /**
     * Establish connection (WebTransport or WebSocket)
     */
    private connect(): void {
        this.intentionallyClosed = false;

        // TODO: WebTransport support (Phase 2.3)
        // For now, always use WebSocket
        this.initWebSocket();
    }

    /**
     * Initialize WebSocket connection
     */
    private initWebSocket(): void {
        const wsUrl = this.options.url.replace('https://', 'wss://').replace('http://', 'ws://');
        const url = `${wsUrl}/ws/${this.options.userId}`;

        console.log(`[EdgeCellTransport] Connecting via WebSocket: ${url}`);
        this.protocol = 'websocket';

        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log(`[EdgeCellTransport] Connected (${this.protocol})`);
            this.reconnectAttempts = 0;
            this.options.onConnect();
        };

        this.ws.onmessage = (event: MessageEvent) => {
            if (event.data instanceof ArrayBuffer) {
                this.handleMessage(event.data);
            } else {
                console.warn('[EdgeCellTransport] Received non-binary message:', event.data);
            }
        };

        this.ws.onclose = () => {
            console.log(`[EdgeCellTransport] Disconnected (${this.protocol})`);
            this.options.onDisconnect();
            this.ws = null;

            // Auto-reconnect if enabled and not intentionally closed
            if (this.options.autoReconnect && !this.intentionallyClosed) {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = (event) => {
            const error = new Error(`WebSocket error: ${event.type}`);
            console.error('[EdgeCellTransport] Error:', error);
            this.options.onError(error);
        };
    }

    /**
     * Schedule reconnection attempt with exponential backoff + jitter.
     * Cell 再起動時に全クライアントが同時に再接続する thundering herd を避ける。
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer !== null) {
            return; // Already scheduled
        }

        const exp = Math.min(
            this.options.reconnectDelay * 2 ** this.reconnectAttempts,
            this.options.maxReconnectDelay,
        );
        const delay = Math.round(exp * (0.5 + Math.random() * 0.5));
        this.reconnectAttempts++;

        console.log(`[EdgeCellTransport] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    /**
     * Handle incoming binary message
     */
    private handleMessage(data: ArrayBuffer): void {
        // Notify all registered handlers
        this.messageHandlers.forEach(handler => {
            try {
                handler(data);
            } catch (error) {
                console.error('[EdgeCellTransport] Handler error:', error);
            }
        });
    }

    /**
     * Send binary data
     */
    send(data: Uint8Array): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('[EdgeCellTransport] Cannot send: not connected');
            return;
        }

        this.ws.send(data);
    }

    /**
     * Register message handler
     */
    onMessage(handler: (data: ArrayBuffer) => void): () => void {
        this.messageHandlers.add(handler);

        // Return unsubscribe function
        return () => {
            this.messageHandlers.delete(handler);
        };
    }

    /**
     * Close connection
     */
    close(): void {
        this.intentionallyClosed = true;

        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        console.log('[EdgeCellTransport] Closed');
    }

    /**
     * Get current protocol
     */
    getProtocol(): TransportProtocol {
        return this.protocol;
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
}
