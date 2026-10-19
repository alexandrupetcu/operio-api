import type { AlertWindows } from "../tenant/alert-settings.js";

/**
 * Regula din panou pentru o fișă cu `d` zile rămase până la termen (negativ = depășit):
 * apare de la `osRegistrationDashboardDays` înainte, e urgentă de la
 * `osRegistrationWarningDays`; cele depășite apar și sunt urgente mereu.
 */
export function osFeedState(
  d: number,
  w: Pick<AlertWindows, "osRegistrationWarningDays" | "osRegistrationDashboardDays">,
) {
  const overdue = d < 0;
  return {
    show: overdue || d <= w.osRegistrationDashboardDays,
    urgent: overdue || d <= w.osRegistrationWarningDays,
    overdue,
  };
}
