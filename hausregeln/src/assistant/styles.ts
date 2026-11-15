/** Additions of the feature assistants to the wizard look: steppers, rows with a control, time-of-day grid. */
import { css } from 'lit';

export const assistantStyles = css`
  .row.wrap {
    flex-wrap: wrap;
    row-gap: var(--hr-space-2);
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--hr-space-2);
  }
  .stepper button {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 0;
    background: var(--hr-fill);
    color: var(--hr-label);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .stepper output {
    min-width: 64px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .slot {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-2);
    padding: var(--hr-space-3) var(--hr-space-4);
  }
  .slot .top {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    flex-wrap: wrap;
  }
  .slot .top b {
    flex: 1;
    min-width: 120px;
  }
  .slot .top small {
    color: var(--hr-label-2);
    font-weight: 400;
    margin-left: 6px;
  }
  .swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    display: inline-block;
    vertical-align: -2px;
    margin-right: 6px;
    box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.2);
  }
  input.time {
    min-height: 36px;
    border: 0;
    border-radius: var(--hr-radius-s, 8px);
    background: var(--hr-fill);
    color: var(--hr-label);
    padding: 0 var(--hr-space-2);
    font: inherit;
  }
  .sum .row .ic.on {
    color: var(--hr-green);
  }
  .sum .row .ic.off {
    color: var(--hr-label-3);
  }
`;
