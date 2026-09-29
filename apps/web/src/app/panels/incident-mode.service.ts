import { Injectable, signal } from '@angular/core';

/**
 * Whether incident mode is on: the canvas draws live health and traffic, and
 * the incident panel takes the review dock's place.
 */
@Injectable({ providedIn: 'root' })
export class IncidentModeService {
  readonly active = signal(false);

  toggle(): void {
    this.active.update((on) => !on);
  }
}
