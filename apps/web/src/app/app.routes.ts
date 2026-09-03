import type { Routes } from '@angular/router';
import { BoardComponent } from './board.component';

/**
 * The room id lives in the URL so that sharing the link is the entire sharing
 * mechanism. No accounts, no invitations: paste the URL and you are editing the
 * same diagram.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: newRoomPath() },
  { path: ':roomId', component: BoardComponent },
  { path: '**', redirectTo: '' },
];

function newRoomPath(): string {
  // Short, URL-safe, and long enough that rooms are not guessable in practice.
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
