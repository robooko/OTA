// Checks the QuickBooks P&L parser and the signed OAuth state. No DB, no network.
//   node -r dotenv/config scripts/check-quickbooks.js
process.env.QBO_CLIENT_SECRET ||= 'check-secret';
const assert = require('node:assert/strict');
const { summarizeProfitAndLoss, signState, verifyState } = require('../src/controllers/quickbooks');

const data = (name, amount, id) => ({ type: 'Data', ColData: [{ value: name, id }, { value: amount }] });
const section = (group, rows, total) => ({ group, Rows: { Row: rows }, Summary: { ColData: [{ value: `Total ${group}` }, { value: total }] } });

// Shape of a real ProfitAndLoss response (summarize_column_by=Total).
const report = {
  Header: { Currency: 'GBP' },
  Rows: { Row: [
    section('Income', [data('Treatments', '5000.00', '1')], '5000.00'),
    section('COGS', [data('Products', '300.50', '2')], '300.50'),
    { group: 'GrossProfit', Summary: { ColData: [{ value: 'Gross Profit' }, { value: '4699.50' }] } },
    section('Expenses', [
      data('Rent or Lease', '1200.00', '3'),
      // parent with sub-accounts, plus its own direct posting
      { Header: { ColData: [{ value: 'Utilities' }, { value: '' }] }, Rows: { Row: [
        data('Utilities', '10.00', '4'),
        data('Electric', '250.25', '5'),
        data('Water', '0.00', '6'),
      ] }, Summary: { ColData: [{ value: 'Total Utilities' }, { value: '260.25' }] } },
    ], '1460.25'),
    section('OtherExpenses', [data('Bank fees', '15.00', '7')], '15.00'),
    { group: 'NetIncome', Summary: { ColData: [{ value: 'Net Income' }, { value: '3224.25' }] } },
  ] },
};

const s = summarizeProfitAndLoss(report);
assert.equal(s.currency, 'GBP');
assert.equal(s.income, 5000);
assert.equal(s.net_income, 3224.25);
assert.equal(s.total_costs, 1775.75); // 300.50 + 1460.25 + 15.00
assert.deepEqual(s.costs.map((c) => [c.group, c.account, c.amount]), [
  ['COGS', 'Products', 300.5],
  ['Expenses', 'Rent or Lease', 1200],
  ['Expenses', 'Utilities', 10],
  ['Expenses', 'Electric', 250.25],
  ['OtherExpenses', 'Bank fees', 15],
]); // zero-amount Water dropped
assert.equal(s.costs.reduce((a, c) => a + c.amount, 0).toFixed(2), '1775.75');

// Empty company / no activity: QBO returns no Rows at all.
assert.deepEqual(summarizeProfitAndLoss({ Header: {} }), { currency: null, income: 0, total_costs: 0, net_income: 0, costs: [] });

const state = signState('org_abc123');
assert.equal(verifyState(state), 'org_abc123');
assert.equal(verifyState(state.replace('org_abc123', 'org_other')), null);
assert.equal(verifyState(state.slice(0, -1) + (state.endsWith('0') ? '1' : '0')), null);
assert.equal(verifyState('org_abc123.'), null);
assert.equal(verifyState(undefined), null);

console.log('ok   quickbooks');
