/**
 * Re-export surface for tests and future consumers.
 *
 * Keeps the primitives and the tab contract importable without pulling the whole
 * stateful view into a test module graph.
 */
export {
  ArchivedBadge, CurrencyKpiRow, EmptyState, ErrorState, FixtureNotice, LoadingState,
  Money, MoneyByCurrencyLines, SectionHeading, StatusBadge,
} from "./finance-primitives";
export { FINANCE_TABS, FINANCE_TAB_LABELS, type FinanceTab, type FinanceRange } from "./finance-view";
