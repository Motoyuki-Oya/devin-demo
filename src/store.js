import { randomUUID } from 'node:crypto';

// インメモリの投稿ストア。新しい順（先頭が最新）で保持する。
// デモ用途のため揮発性。永続化したい場合は listPosts / createPost の
// 実装を DB や JSON ファイルに差し替えれば拡張できる。
const posts = [];

const MAX_POSTS = 100;
const MAX_AUTHOR_LEN = 50;
const MAX_CONTENT_LEN = 500;

export function listPosts() {
  return posts;
}

export function createPost({ author, content } = {}) {
  const trimmedContent = String(content ?? '').trim();
  if (trimmedContent.length === 0) {
    throw new Error('投稿内容を入力してください');
  }

  const post = {
    id: randomUUID(),
    author: String(author ?? '').trim().slice(0, MAX_AUTHOR_LEN) || '名無しさん',
    content: trimmedContent.slice(0, MAX_CONTENT_LEN),
    createdAt: Date.now(),
  };

  posts.unshift(post);
  if (posts.length > MAX_POSTS) {
    posts.length = MAX_POSTS;
  }

  return post;
}
