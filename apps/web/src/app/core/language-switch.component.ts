import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LOCALES, activeLocale, switchLocale } from './locale';

/**
 * Offers the other language, named in that language ("Deutsch" while in
 * English, "English" while in German), so someone who cannot read the current
 * one can still find their way out. Switching reloads the app (see locale.ts).
 */
@Component({
  selector: 'keel-language-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="keel-btn keel-btn--ghost"
      [attr.lang]="other.id"
      [attr.title]="title"
      (click)="choose()"
    >
      {{ other.label }}
    </button>
  `,
})
export class LanguageSwitchComponent {
  protected readonly other = LOCALES.find((l) => l.id !== activeLocale())!;
  protected readonly title = $localize`:Tooltip on the language switch button:Change the language`;

  protected choose(): void {
    switchLocale(this.other.id);
  }
}
