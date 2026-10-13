// Owns the selected company and request lifetime; independent of the DOM.
import { createCompany } from '../data/companies.js';

export function createCompanySession(initialCompany) {
  let company = createCompany(initialCompany);
  const requests = new Map();
  return {
    get company() { return company; },
    select(nextCompany) {
      const next = createCompany(nextCompany);
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      company = next;
      return company;
    },
    begin(module) {
      requests.get(module)?.abort();
      const controller = new AbortController();
      requests.set(module, controller);
      return { ticker: company.ticker, signal: controller.signal, isCurrent: () => requests.get(module) === controller };
    },
  };
}
