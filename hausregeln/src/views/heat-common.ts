/**
 * Small pieces shared by the heating views (plans-view.ts, heat-explain.ts, setup/heat-wizard.ts): the heating styles
 * with a plain explanation, the building types and the labels of the levels in a learned plan.
 * Functions, not constants: the texts follow the language, so they are built while rendering.
 */
import { t, type I18nKey } from '../i18n';
import type { HeatBuilding, HeatStyle } from '../model';

/** [style, name, what it does in plain words] */
export const heatStyles = (): [HeatStyle, string, string][] => [
  ['comfort', t('heat.style_comfort'), t('heat.style_comfort_text')],
  ['eco', t('heat.style_eco'), t('heat.style_eco_text')],
  ['sport', t('heat.style_sport'), t('heat.style_sport_text')],
];

/** building types: prior for heating up and cooling down until the room model has learned enough */
export const HEAT_BUILDINGS: HeatBuilding[] = ['unknown', 'old', 'partial', 'new', 'passive', 'floor'];

export const buildingLabel = (b: HeatBuilding | undefined): string => t(`heat.building_${b ?? 'unknown'}` as I18nKey);

export const buildingText = (b: HeatBuilding | undefined): string => t(`heat.building_${b ?? 'unknown'}_text` as I18nKey);

const LEVELS = ['comfort', 'setback', 'night', 'preheat', 'custom', 'airing', 'eco'];

/** level of a segment of a learned plan (comfort, setback, night, preheat, custom = fixed time, airing) */
export const levelLabel = (l: string): string => t(`heat.level_${LEVELS.includes(l) ? l : 'other'}` as I18nKey);
