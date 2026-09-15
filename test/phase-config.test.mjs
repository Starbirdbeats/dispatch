import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
test('only agent stations offer phase configuration and non-agent stations still render', () => {
  const nodes = () => ({ innerHTML: '', style: { setProperty() {} }, addEventListener() {}, appendChild() {} });
  const ctx = vm.createContext({
    document: { createElement: nodes }, ticketsIn: () => [], stationAccent: () => 'green',
    stationHarnessLabel: (c) => c.harness.type, esc: (s) => s, isProviderEnabled: () => true,
    S: { data: { runs: { running: [] } } },
    $: (selector, el) => selector === '.cfg' ? (el.innerHTML.includes('data-cfg=') ? nodes() : null) : nodes(),
  });
  vm.runInContext(src.slice(src.indexOf('function stationEl('), src.indexOf('\nfunction chipEl(')), ctx);
  for (const role of ['intake', 'terminal', 'human-gate', 'agent']) {
    const el = ctx.stationEl({ id: role, name: role, role, harness: { type: role === 'agent' ? 'codex' : 'human' } });
    assert.equal(el.innerHTML.includes('data-cfg='), role === 'agent');
  }
});

test('direct CFG routes cannot open intake or terminal configuration', () => {
  let closed = 0;
  const ctx = vm.createContext({ S: { modal: { id: 'c' }, data: { board: { columns: [] } } }, closeModal: () => ++closed });
  const begin = src.indexOf('function renderColumnModal(');
  vm.runInContext(src.slice(begin, src.indexOf('\n/* ---- new ticket modal', begin)), ctx);
  for (const role of ['intake', 'terminal']) {
    ctx.S.data.board.columns = [{ id: 'c', role }]; ctx.renderColumnModal();
  }
  assert.equal(closed, 2);
});
