/** Short, URL-safe, and long enough that rooms are not guessable in practice. */
export function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
