import protobuf from 'protobufjs';

// Load and compile proto file
const root = await protobuf.load('/proto/messages.proto');

// Get message types
export const ClientMessage = root.lookupType('edgecell.ClientMessage');
export const ServerMessage = root.lookupType('edgecell.ServerMessage');
export const IncrementRequest = root.lookupType('edgecell.IncrementRequest');
export const CounterUpdate = root.lookupType('edgecell.CounterUpdate');
export const CreatePostRequest = root.lookupType('edgecell.CreatePostRequest');
export const ToggleReactionRequest = root.lookupType('edgecell.ToggleReactionRequest');
export const EditPostRequest = root.lookupType('edgecell.EditPostRequest');
export const Post = root.lookupType('edgecell.Post');
export const PostList = root.lookupType('edgecell.PostList');
export const Reaction = root.lookupType('edgecell.Reaction');
export const ReactionUpdate = root.lookupType('edgecell.ReactionUpdate');
export const EditResult = root.lookupType('edgecell.EditResult');

// Helper to create INCREMENT message
export function createIncrementMessage(userId: string): Uint8Array {
    const incrementRequest = IncrementRequest.create({ userId });
    const clientMessage = ClientMessage.create({ increment: incrementRequest });
    return ClientMessage.encode(clientMessage).finish();
}

// Helper to create a CREATE_POST message (掲示板への投稿)
// password を入れて投稿すると、同じパスワードで後から編集できる。
export function createPostMessage(author: string, content: string, password: string): Uint8Array {
    const createPost = CreatePostRequest.create({ author, content, password });
    const clientMessage = ClientMessage.create({ createPost });
    return ClientMessage.encode(clientMessage).finish();
}

// Helper to create an EDIT_POST message（投稿時に設定したパスワードが一致した場合のみ反映される）
export function editPostMessage(postId: string, content: string, password: string): Uint8Array {
    const editPost = EditPostRequest.create({ postId, content, password });
    const clientMessage = ClientMessage.create({ editPost });
    return ClientMessage.encode(clientMessage).finish();
}

// Helper to create a TOGGLE_REACTION message（同じ author が同じ絵文字を再送すると解除される）
export function toggleReactionMessage(postId: string, emoji: string, author: string): Uint8Array {
    const toggleReaction = ToggleReactionRequest.create({ postId, emoji, author });
    const clientMessage = ClientMessage.create({ toggleReaction });
    return ClientMessage.encode(clientMessage).finish();
}

// Helper to parse server message
export function parseServerMessage(buffer: ArrayBuffer): any {
    const bytes = new Uint8Array(buffer);
    const serverMessage = ServerMessage.decode(bytes);
    return serverMessage;
}
