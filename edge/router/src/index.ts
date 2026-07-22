export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // MY_KV_NAMESPACE: KVNamespace;
  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cookie = request.headers.get("Cookie") || "";
    
    // 1. Find 'routing_id' from cookie
    let routingId = getCookie(cookie, "routing_id");
    let isNewUser = false;

    // 2. Generate if missing (Temporary ID)
    if (!routingId) {
      routingId = crypto.randomUUID();
      isNewUser = true;
    }

    // 3. Determine target cell (0-3)
    const cellId = getCellId(routingId);
    
    // 4. Select Origin
    // In production, this would be `cell-${cellId}.origin.edge-cell.com`
    // For local testing, we might just log it or forward to different ports if running locally.
    // For now, let's keep the production logic logic commented or generic.
    const targetOrigin = `cell-${cellId}.origin.edge-cell.com`;
    
    // 5. Prepare request
    // url.hostname = targetOrigin; // Commented out to prevent actual DNS lookup failure in local dev without hosts file
    
    // Add header for backend visibility
    const newRequest = new Request(url.toString(), request);
    newRequest.headers.set("X-Routing-ID", routingId);
    newRequest.headers.set("X-Target-Cell", cellId.toString());

    // 6. Execute fetch (In real world, this forwards the request)
    // const response = await fetch(newRequest);
    
    // For demo/testing without real backends:
    // We will just return a text response saying where we would have gone.
    const responseBody = `Welcome to EdgeCell Grid.\nYour Routing ID: ${routingId}\nAssigned Cell: ${cellId}\nTarget Origin: ${targetOrigin}`;
    const response = new Response(responseBody, { status: 200 });

    // 7. Set cookie if new user
    if (isNewUser) {
      // Clone response to make headers mutable if it came from fetch
      const newResponse = new Response(response.body, response);
      newResponse.headers.append(
        "Set-Cookie", 
        `routing_id=${routingId}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`
      );
      return newResponse;
    }

    return response;
  }
};

// Utility: Hash UUID to cell ID (0-3)
function getCellId(uuid: string): number {
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    hash = ((hash << 5) - hash) + uuid.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 4;
}

// Utility: Get cookie value
function getCookie(cookieString: string, name: string): string | null {
  const match = cookieString.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}
