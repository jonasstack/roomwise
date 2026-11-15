/**
 * The parts of Hausregeln that can be switched off (Einstellungen → Funktionen) and the one hint shown
 * wherever a switched-off part would appear. Same words everywhere: these labels are the names of the areas.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { mdiAirplane, mdiBrain, mdiHomeAutomation, mdiLightbulbGroupOutline, mdiPowerPlugOffOutline, mdiRadiator, mdiRobotVacuum, mdiShieldHomeOutline, mdiDoorOpen, mdiWindowOpenVariant } from '@mdi/js';
import type { FeatureId } from '../model';
import { fire, icon } from '../design/shared';
import { t, type I18nKey } from '../i18n';
// i18n: complete

export interface FeatureMeta {
  label: string;
  /** what it does, one short sentence */
  sub: string;
  icon: string;
  /** its own area in the navigation */
  tab?: string;
  /** the area that holds those settings (link "Öffnen"), optionally with a place in it: "alarm#window-warning" */
  in?: string;
  /** only works together with this feature */
  needs?: FeatureId;
}

/** the order in Einstellungen → Funktionen ("behaviours", the room behaviours, are dissolved and no longer listed) */
export const FEATURE_ORDER: FeatureId[] = ['light', 'heating', 'alarm', 'window_warning', 'vacation', 'mode_auto', 'vacuum', 'ai'];

/** The texts are looked up when read, so they follow the language. */
const meta = (id: FeatureId, icon: string, more: Partial<FeatureMeta> = {}): FeatureMeta => {
  const m = {
    get label() {
      return t(`settings.feature_${id}` as I18nKey);
    },
    get sub() {
      return t(`settings.feature_${id}_sub` as I18nKey);
    },
    icon,
    ...more,
  } as FeatureMeta;
  return m;
};

// built untyped and cast: tolerant while ids are added or dissolved (an id no longer in FeatureId is simply unused)
const ALL = {
  light: meta('light', mdiLightbulbGroupOutline, { tab: 'light' }),
  heating: meta('heating', mdiRadiator, { tab: 'heat' }),
  alarm: meta('alarm', mdiShieldHomeOutline, { tab: 'alarm' }),
  window_warning: meta('window_warning', mdiWindowOpenVariant, { in: 'alarm#window-warning' }),
  vacation: meta('vacation' as FeatureId, mdiAirplane, { in: 'settings#urlaub', needs: 'light' }),
  mode_auto: meta('mode_auto', mdiHomeAutomation, { in: 'home#mode-auto' }),
  // dissolved (room behaviours): kept so that old links and hints do not break
  behaviours: meta('behaviours' as FeatureId, mdiDoorOpen, { in: 'rooms' }),
  vacuum: meta('vacuum', mdiRobotVacuum, { in: 'rooms' }),
  ai: meta('ai', mdiBrain),
};
export const FEATURES = ALL as unknown as Record<FeatureId, FeatureMeta>;

/** features with their own small assistant (assistant/*.ts); it switches the feature on at the end */
const ASSISTED: FeatureId[] = ['light', 'alarm', 'window_warning', 'vacation', 'vacuum', 'mode_auto'];

/** "… ist ausgeschaltet" with a way to the switch (and to the feature's assistant). Only one place switches features: Einstellungen → Funktionen. */
export function featureHint(el: EventTarget, f: FeatureId, text?: string): TemplateResult {
  const m = FEATURES[f];
  return html`<div class="fhint">
    ${icon(mdiPowerPlugOffOutline, 20)}
    <span class="grow"><b>${t('settings.feature_off', { name: m.label })}</b> ${text ?? m.sub}</span>
    ${ASSISTED.includes(f) ? html`<button class="btn small" @click=${() => fire(el, 'hr-assistant', { feature: f })}>${t('settings.with_assistant')}</button>` : nothing}
    <button class="btn small tinted" @click=${() => fire(el, 'hr-tab', 'settings')}>${t('settings.switch_on')}</button>
  </div>`;
}
