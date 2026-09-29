import { Injectable, signal } from '@angular/core';

/**
 * Whether review mode is on: the Changes tab of the review dock is open, and
 * the canvas draws the diff against the approved design instead of findings.
 *
 * Its own service because the dock turns it on and the canvas reads it, and
 * neither should have to reach into the other.
 */
@Injectable({ providedIn: 'root' })
export class ChangeReviewService {
  readonly active = signal(false);
}
