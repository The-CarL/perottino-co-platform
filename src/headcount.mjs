export const maxCompanyEmployees = 100;

export function isValidEmployeeLimit(limit) {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maxCompanyEmployees;
}
