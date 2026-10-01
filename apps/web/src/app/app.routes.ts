import type { Routes } from '@angular/router';
import { InviteComponent } from './invite/invite.component';
import { LandingComponent } from './landing/landing.component';

/**
 * The room id lives in the URL, and for a link room sharing the link is the
 * entire sharing mechanism: paste it and you are editing the same diagram. A
 * room moved into a workspace opens only for its members, who join through an
 * `/invite/:token` link. `''` shows the landing page rather than minting a room
 * immediately, so a first-time visitor sees what Keel is before a diagram
 * exists under them. The board is lazy so the landing page does not ship it.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', component: LandingComponent },
  { path: 'invite/:token', component: InviteComponent },
  { path: ':roomId', loadComponent: () => import('./board.component').then((m) => m.BoardComponent) },
  { path: '**', redirectTo: '' },
];
