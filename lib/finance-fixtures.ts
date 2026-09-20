import type { FinanceDataset } from "./finance-types";

/**
 * Development fixtures.
 *
 * Shaped to exercise the cases the UI must get right rather than to look tidy:
 * two currencies side by side, an archived account, a cross-currency transfer, a
 * transaction with no project, a subcategory, an overdue subscription and a
 * custom cadence. Replaced wholesale once `feat/finance-core` serves the API.
 */
export const FINANCE_FIXTURES: FinanceDataset = {
  accounts: [
    { id: "acc-1", name: "Asosiy kassa", type: "CASH", currency: "UZS", openingBalance: 40_000_000, currentBalance: 125_400_000, status: "ACTIVE" },
    { id: "acc-2", name: "Kapitalbank hisob", type: "BANK", currency: "UZS", openingBalance: 10_000_000, currentBalance: 68_250_000, status: "ACTIVE" },
    { id: "acc-3", name: "Payme karta", type: "CARD", currency: "UZS", openingBalance: 0, currentBalance: 3_120_000, status: "ACTIVE" },
    { id: "acc-4", name: "USD hisob", type: "BANK", currency: "USD", openingBalance: 1_000, currentBalance: 4_200, status: "ACTIVE" },
    { id: "acc-5", name: "Eski hamyon", type: "OTHER", currency: "UZS", openingBalance: 500_000, currentBalance: 0, status: "ARCHIVED" },
  ],
  categories: [
    { id: "cat-in-1", name: "Mijoz to‘lovi", kind: "INCOME", parentId: null, status: "ACTIVE" },
    { id: "cat-in-2", name: "Obuna to‘lovi", kind: "INCOME", parentId: "cat-in-1", status: "ACTIVE" },
    { id: "cat-in-3", name: "Boshqa kirim", kind: "INCOME", parentId: null, status: "ACTIVE" },
    { id: "cat-ex-1", name: "Ish haqi", kind: "EXPENSE", parentId: null, status: "ACTIVE" },
    { id: "cat-ex-2", name: "Marketing", kind: "EXPENSE", parentId: null, status: "ACTIVE" },
    { id: "cat-ex-3", name: "Reklama", kind: "EXPENSE", parentId: "cat-ex-2", status: "ACTIVE" },
    { id: "cat-ex-4", name: "Kontent", kind: "EXPENSE", parentId: "cat-ex-2", status: "ACTIVE" },
    { id: "cat-ex-5", name: "Ofis", kind: "EXPENSE", parentId: null, status: "ACTIVE" },
    { id: "cat-ex-6", name: "Eski xarajat", kind: "EXPENSE", parentId: null, status: "ARCHIVED" },
  ],
  projects: [
    { id: "prj-1", name: "IBOX platforma", description: "Asosiy mahsulot", status: "ACTIVE" },
    { id: "prj-2", name: "SD yo‘nalishi", description: "Ikkinchi brend", status: "ACTIVE" },
    { id: "prj-3", name: "Yopilgan tashabbus", description: null, status: "ARCHIVED" },
  ],
  transactions: [
    { id: "tx-1", date: "2026-09-02", type: "INCOME", accountId: "acc-2", toAccountId: null, categoryId: "cat-in-1", projectId: "prj-1", description: "Sentyabr mijoz to‘lovlari", amount: 42_000_000, currency: "UZS", toAmount: null, toCurrency: null },
    { id: "tx-2", date: "2026-09-04", type: "EXPENSE", accountId: "acc-1", toAccountId: null, categoryId: "cat-ex-1", projectId: "prj-1", description: "Sentyabr ish haqi", amount: 28_500_000, currency: "UZS", toAmount: null, toCurrency: null },
    { id: "tx-3", date: "2026-09-05", type: "EXPENSE", accountId: "acc-3", toAccountId: null, categoryId: "cat-ex-3", projectId: "prj-2", description: "Instagram reklama", amount: 4_800_000, currency: "UZS", toAmount: null, toCurrency: null },
    { id: "tx-4", date: "2026-09-08", type: "EXPENSE", accountId: "acc-3", toAccountId: null, categoryId: "cat-ex-4", projectId: null, description: "Kontent ishlab chiqish", amount: 2_150_000, currency: "UZS", toAmount: null, toCurrency: null },
    { id: "tx-5", date: "2026-09-10", type: "INCOME", accountId: "acc-4", toAccountId: null, categoryId: "cat-in-2", projectId: "prj-2", description: "Xalqaro obuna", amount: 1_800, currency: "USD", toAmount: null, toCurrency: null },
    { id: "tx-6", date: "2026-09-12", type: "TRANSFER", accountId: "acc-1", toAccountId: "acc-2", categoryId: null, projectId: null, description: "Kassadan bankka", amount: 15_000_000, currency: "UZS", toAmount: null, toCurrency: null },
    { id: "tx-7", date: "2026-09-14", type: "TRANSFER", accountId: "acc-2", toAccountId: "acc-4", categoryId: null, projectId: null, description: "Valyuta ayirboshlash", amount: 12_600_000, currency: "UZS", toAmount: 1_000, toCurrency: "USD" },
    { id: "tx-8", date: "2026-09-16", type: "EXPENSE", accountId: "acc-2", toAccountId: null, categoryId: "cat-ex-5", projectId: null, description: "Ofis ijarasi", amount: 9_000_000, currency: "UZS", toAmount: null, toCurrency: null },
    { id: "tx-9", date: "2026-09-17", type: "EXPENSE", accountId: "acc-4", toAccountId: null, categoryId: "cat-ex-2", projectId: "prj-2", description: "Xalqaro reklama platformasi", amount: 640, currency: "USD", toAmount: null, toCurrency: null },
    { id: "tx-10", date: "2026-09-18", type: "INCOME", accountId: "acc-1", toAccountId: null, categoryId: null, projectId: null, description: "Kategoriyasiz kirim", amount: 1_250_000, currency: "UZS", toAmount: null, toCurrency: null },
  ],
  subscriptions: [
    { id: "sub-1", name: "Bitrix24", amount: 1_450_000, currency: "UZS", accountId: "acc-2", categoryId: "cat-ex-5", projectId: "prj-1", cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-09-25", status: "ACTIVE" },
    { id: "sub-2", name: "Cloudflare", amount: 25, currency: "USD", accountId: "acc-4", categoryId: "cat-ex-5", projectId: null, cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-09-18", status: "ACTIVE" },
    { id: "sub-3", name: "Server hosting", amount: 3_600_000, currency: "UZS", accountId: "acc-2", categoryId: "cat-ex-5", projectId: "prj-1", cadence: "QUARTERLY", intervalMonths: null, nextDueDate: "2026-10-01", status: "ACTIVE" },
    { id: "sub-4", name: "Domen", amount: 40, currency: "USD", accountId: "acc-4", categoryId: "cat-ex-5", projectId: null, cadence: "YEARLY", intervalMonths: null, nextDueDate: "2027-02-11", status: "ACTIVE" },
    { id: "sub-5", name: "Auditor xizmati", amount: 5_000_000, currency: "UZS", accountId: "acc-2", categoryId: "cat-ex-5", projectId: null, cadence: "CUSTOM_MONTHS", intervalMonths: 4, nextDueDate: "2026-09-28", status: "ACTIVE" },
    { id: "sub-6", name: "Eski CRM", amount: 900_000, currency: "UZS", accountId: "acc-2", categoryId: null, projectId: null, cadence: "MONTHLY", intervalMonths: null, nextDueDate: "2026-08-01", status: "ARCHIVED" },
  ],
};

/** A deep copy, so a mock adapter's writes cannot leak between tests. */
export const cloneFixtures = (): FinanceDataset => structuredClone(FINANCE_FIXTURES);
