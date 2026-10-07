import { Pipe, type PipeTransform } from '@angular/core';

const GITHUB_AVATAR_HOST = 'avatars.githubusercontent.com';

/**
 * Asks the avatar host for a picture `px` pixels square instead of the full
 * upload. GitHub serves the original by default (a 460px photo is ~280 kB for a
 * 22px circle) and honours `s=` to resize. Other hosts and unparseable URLs are
 * returned unchanged, since their size parameters differ.
 */
export function sizedAvatarUrl(url: string, px: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== GITHUB_AVATAR_HOST) return url;
  parsed.searchParams.set('s', String(px));
  return parsed.toString();
}

/** `[src]="url | avatarSize: 44"`, where 44 is the rendered size times two for high-DPI screens. */
@Pipe({ name: 'avatarSize' })
export class AvatarSizePipe implements PipeTransform {
  transform(url: string, px: number): string {
    return sizedAvatarUrl(url, px);
  }
}
