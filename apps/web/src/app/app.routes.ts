import type { Routes } from '@angular/router';
import { BoardComponent } from './board.component';
import { LandingComponent } from './landing/landing.component';

/**
 * The room id lives in the URL so that sharing the link is the entire sharing
 * mechanism. No accounts, no invitations: paste the URL and you are editing the
 * same diagram. `''` shows the landing page rather than minting a room
 * immediately, so a first-time visitor sees what Keel is before a diagram
 * exists under them.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', component: LandingComponent },
  { path: ':roomId', component: BoardComponent },
  { path: '**', redirectTo: '' },
];
