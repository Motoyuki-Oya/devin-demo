import protobuf from 'protobufjs';

// Load and compile proto file
const root = await protobuf.load('/proto/messages.proto');

// Get message types
export const ClientMessage = root.lookupType('edgecell.ClientMessage');
export const ServerMessage = root.lookupType('edgecell.ServerMessage');
export const IncrementRequest = root.lookupType('edgecell.IncrementRequest');
export const CounterUpdate = root.lookupType('edgecell.CounterUpdate');
export const CreatePostRequest = root.lookupType('edgecell.CreatePostRequest');
export const Post = root.lookupType('edgecell.Post');
export const PostList = root.lookupType('edgecell.PostList');

// Helper to create INCREMENT message
export function createIncrementMessage(userId: string): Uint8Array {
    const incrementRequest = IncrementRequest.create({ userId });
    const clientMessage = ClientMessage.create({ increment: incrementRequest });
    return ClientMessage.encode(clientMessage).finish();
}

// Helper to create a CREATE_POST message (掲示板への投稿)
export function createPostMessage(author: string, content: string): Uint8Array {
    const createPost = CreatePostRequest.create({ author, content });
    const clientMessage = ClientMessage.create({ createPost });
    return ClientMessage.encode(clientMessage).finish();
}

// Helper to parse server message
export function parseServerMessage(buffer: ArrayBuffer): any {
    const bytes = new Uint8Array(buffer);
    const serverMessage = ServerMessage.decode(bytes);
    return serverMessage;
}
