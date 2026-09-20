/**
 * Re-export surface for tests and future consumers.
 *
 * Keeps the primitives and the tab contract importable without pulling the whole
 * stateful view into a test module graph.
 */
export {
  ArchivedBadge, ArchiveStatusBadge, CurrencyKpiRow, EmptyState, ErrorState, FinanceCurrencyProvider,
  FixtureNotice, LoadingState, Money, MoneyByCurrencyLines, SectionHeading,
} from "./finance-primitives";
export { FINANCE_TABS, FINANCE_TAB_LABELS, type FinanceTab, type FinanceRange } from "./finance-view";
