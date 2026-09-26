'use strict';

/* 核验引擎单元测试：node test/verify.test.js */

const assert = require('assert');
const { verifyAll, holdingsAt, STATUS, CONFLICT, WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n; // 录入先后用递增 createdAt 表示

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to, n) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 完整链并归仓
test('完整交接链 -> RETURNED', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 1),
    rec('p0', 3, '张三', '李四', 2),
    rec('p0', 8, '李四', '张三', 3),
    rec('p0', 12, '张三', WAREHOUSE, 4),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.length, 4);
  assert.strictEqual(results[0].holder, WAREHOUSE);
});

// 2. 同一分钟多条可接续 -> AMBIGUOUS
test('同一分钟同一持有人多条可接续 -> CONFLICT/AMBIGUOUS', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 1),
    rec('p0', 5, '张三', '王五', 2),
    rec('p0', 5, '张三', '赵六', 3),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(results[0].conflict.records.length, 2);
  assert.strictEqual(results[0].conflict.minute, 5);
  assert.strictEqual(results[0].replayedCount, 1);
});

// 3. 持有人对不上 -> BROKEN
test('交出者不是当前持有人 -> CONFLICT/BROKEN', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 1),
    rec('p0', 4, '李四', '钱七', 2),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.BROKEN);
  assert.strictEqual(results[0].conflict.holder, '王五');
  assert.strictEqual(results[0].conflict.records.length, 1);
});

// 4. 未归仓
test('全部重放但未归仓 -> NOT_RETURNED', () => {
  const data = mkData(['印'], [
    rec('p0', 1, WAREHOUSE, '周八', 1),
    rec('p0', 6, '周八', '孙七', 2),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.NOT_RETURNED);
  assert.strictEqual(results[0].holder, '孙七');
});

// 5. 同一分钟链式交接（A→B, B→C）可被识别
test('同一分钟链式交接按录入顺序连成唯一链', () => {
  const data = mkData(['枪'], [
    rec('p0', 3, WAREHOUSE, '甲', 1),
    rec('p0', 7, '甲', '乙', 2),
    rec('p0', 7, '乙', '丙', 3),
    rec('p0', 7, '丙', WAREHOUSE, 4),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.length, 4);
});

// 6. 同分钟链式交接与录入顺序无关（倒序录入同样连成唯一链）
test('同一分钟链式交接与录入顺序无关', () => {
  const data = mkData(['鞭'], [
    rec('p0', 7, '乙', WAREHOUSE, 3),
    rec('p0', 7, '甲', '乙', 2),
    rec('p0', 7, WAREHOUSE, '甲', 1),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.map((r) => r.to).join(','), ['甲', '乙', WAREHOUSE].join(','));
});

// 7. 同一分钟两条记录都无法从当前持有人接续 -> BROKEN，且都被定位
test('同一分钟多条记录均无法接续 -> BROKEN，全部定位', () => {
  const data = mkData(['锤'], [
    rec('p0', 7, '甲', '乙', 1),
    rec('p0', 7, '丙', '丁', 2),
  ]);  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.BROKEN);
  // 断链后另一条（仓库->甲）也无法执行，应一并被定位
  assert.strictEqual(results[0].conflict.records.length, 2);
});

// 9. 跨分钟：第一分钟正常，第二分钟才出现歧义，之前的链保留
test('歧义发生在后一分钟，之前的链保留', () => {
  const data = mkData(['旗'], [
    rec('p0', 1, WAREHOUSE, '甲', 1),
    rec('p0', 3, '甲', '乙', 2),
    rec('p0', 9, '乙', '丙', 3),
    rec('p0', 9, '乙', '丁', 4),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(results[0].conflict.minute, 9);
  assert.strictEqual(results[0].chain.length, 2);
  assert.strictEqual(results[0].holder, '乙');
});

// 10. 无记录
test('无记录 -> NO_RECORDS', () => {
  const data = mkData(['空箱'], []);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.NO_RECORDS);
  assert.strictEqual(results[0].holder, WAREHOUSE);
});

// 11. 时间轴段数与持有人正确
test('时间轴段反映各持有人的起止分钟', () => {
  const data = mkData(['轴'], [
    rec('p0', 0, WAREHOUSE, '甲', 1),
    rec('p0', 5, '甲', '乙', 2),
    rec('p0', 5, '乙', WAREHOUSE, 3),
  ]);
  const { results } = verifyAll(data);
  const segs = results[0].timeline.segments;
  assert.deepStrictEqual(
    segs.map((s) => [s.holder, s.startMinute, s.endMinute]),
    [[WAREHOUSE, 0, 0], ['甲', 0, 5], ['乙', 5, 5]]
  );
});

// 12. 未归仓时间轴末段开放到演出末分钟
test('未归仓时间轴有开放段且终止于演出末分钟', () => {
  const data = mkData(['伞'], [
    rec('p0', 2, WAREHOUSE, '甲', 1),
    rec('p0', 6, '甲', '乙', 2),
  ]);
  const { results } = verifyAll(data);
  const last = results[0].timeline.segments.at(-1);
  assert.strictEqual(last.holder, '乙');
  assert.strictEqual(last.open, true);
  assert.strictEqual(last.endMinute, 6);
});

// 13. 多道具独立核验，互不影响
test('多道具各自独立核验', () => {
  const data = mkData(['好', '坏'], [
    rec('p0', 1, WAREHOUSE, '甲', 1),
    rec('p0', 2, '甲', WAREHOUSE, 2),
    rec('p1', 1, WAREHOUSE, '乙', 3),
    rec('p1', 2, '乙', '丙', 4),
  ]);
  const { results, summary } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[1].status, STATUS.NOT_RETURNED);
  assert.strictEqual(summary.returned, 1);
  assert.strictEqual(summary.notReturned, 1);
});

// 14. 引用已删除道具的记录进入 orphanRecords
test('孤儿记录被统计且不参与核验', () => {
  const data = {
    props: [{ id: 'p0', name: '仅存', note: '', createdAt: 1 }],
    records: [
      rec('p0', 1, WAREHOUSE, '甲', 1),
      rec('pX', 2, '甲', '乙', 2),
    ],
  };
  const out = verifyAll(data);
  assert.strictEqual(out.orphanRecords.length, 1);
  assert.strictEqual(out.results[0].status, STATUS.NOT_RETURNED);
});

// 15. 同分钟长链：数千条可接续交接（倒序录入）近线性重放，链序与最终持有人正确
test('同分钟数千条链式交接 -> 近线性重放且链序正确', () => {
  const N = 5000;
  // 同一分钟 仓库->甲1->...->甲4999->仓库，倒序录入（同分钟归约与录入顺序无关）
  const records = [];
  for (let k = N - 1; k >= 0; k--) {
    records.push({
      id: `r${k}`,
      propId: 'p0',
      minute: 5,
      from: k === 0 ? WAREHOUSE : `甲${k}`,
      to: k === N - 1 ? WAREHOUSE : `甲${k + 1}`,
      note: '',
      createdAt: t(k),
    });
  }
  const data = { props: [{ id: 'p0', name: '长链', note: '', createdAt: 1 }], records };
  const started = Date.now();
  const { results } = verifyAll(data);
  const elapsed = Date.now() - started;
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.length, N);
  assert.strictEqual(results[0].replayedCount, N);
  assert.strictEqual(results[0].totalCount, N);
  // 链序保持接续顺序：第 k 条为 甲k -> 甲k+1（首条自仓库、末条归仓库）
  assert.strictEqual(results[0].chain[0].id, 'r0');
  assert.strictEqual(results[0].chain[N - 1].id, `r${N - 1}`);
  for (let k = 1; k < N; k++) {
    assert.strictEqual(results[0].chain[k].from, `甲${k}`);
    assert.strictEqual(results[0].chain[k].id, `r${k}`);
  }
  // 性能回归门槛：按交出者分桶后长链随记录数近线性增长；
  // 旧的逐步扫描+复制实现在该规模下需秒级，留出充足余量仍远低于门槛
  assert.ok(elapsed < 1000, `同分钟 ${N} 条长链重放耗时 ${elapsed}ms，超出近线性预期`);
});

// 16. 同分钟长链前缀后歧义：仍返回该持有人的全部可接续记录，冲突前链保留
test('同分钟长链前缀后发生歧义 -> 定位该持有人全部可接续记录', () => {
  const K = 2000;
  const records = [];
  // 同分钟长链前缀：仓库->甲1->...->甲2000
  for (let k = K - 1; k >= 0; k--) {
    records.push({
      id: `r${k}`,
      propId: 'p0',
      minute: 7,
      from: k === 0 ? WAREHOUSE : `甲${k}`,
      to: `甲${k + 1}`,
      note: '',
      createdAt: t(k),
    });
  }
  // 甲2000 同时交给三个人（乱序录入，定位顺序按 createdAt）
  records.push({ id: 'ra3', propId: 'p0', minute: 7, from: `甲${K}`, to: '丁', note: '', createdAt: t(K + 2) });
  records.push({ id: 'ra1', propId: 'p0', minute: 7, from: `甲${K}`, to: '乙', note: '', createdAt: t(K) });
  records.push({ id: 'ra2', propId: 'p0', minute: 7, from: `甲${K}`, to: '丙', note: '', createdAt: t(K + 1) });
  const data = { props: [{ id: 'p0', name: '长链歧义', note: '', createdAt: 1 }], records };
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(results[0].conflict.minute, 7);
  assert.strictEqual(results[0].conflict.holder, `甲${K}`);
  // 歧义仍返回该持有人的全部可接续记录（按记录顺序）
  assert.deepStrictEqual(results[0].conflict.records, ['ra1', 'ra2', 'ra3']);
  assert.deepStrictEqual(
    results[0].conflict.recordRefs.map((r) => r.id),
    ['ra1', 'ra2', 'ra3']
  );
  // 冲突前链完整保留且顺序不变
  assert.strictEqual(results[0].chain.length, K);
  assert.strictEqual(results[0].replayedCount, K);
  assert.strictEqual(results[0].chain[K - 1].id, `r${K - 1}`);
  assert.strictEqual(results[0].holder, `甲${K}`);
});

// 17. 同分钟长链前缀后断链：仍返回当分钟全部未执行记录，冲突前链保留
test('同分钟长链前缀后断链 -> 定位当分钟全部未执行记录', () => {
  const K = 2000;
  const records = [];
  // 同分钟长链前缀：仓库->甲1->...->甲2000（全部可执行）
  for (let k = K - 1; k >= 0; k--) {
    records.push({
      id: `r${k}`,
      propId: 'p0',
      minute: 9,
      from: k === 0 ? WAREHOUSE : `甲${k}`,
      to: `甲${k + 1}`,
      note: '',
      createdAt: t(k),
    });
  }
  // 三条无法从 甲2000 接续的剩余记录（乱序录入，定位顺序按 createdAt）
  records.push({ id: 'rb2', propId: 'p0', minute: 9, from: '丙', to: '丁', note: '', createdAt: t(K + 1) });
  records.push({ id: 'rb1', propId: 'p0', minute: 9, from: '乙', to: '丙', note: '', createdAt: t(K) });
  records.push({ id: 'rb3', propId: 'p0', minute: 9, from: '丁', to: WAREHOUSE, note: '', createdAt: t(K + 2) });
  // 之后分钟的记录同样无法接续，但不计入当分钟定位
  records.push({ id: 'rb4', propId: 'p0', minute: 10, from: `甲${K}`, to: WAREHOUSE, note: '', createdAt: t(K + 3) });
  const data = { props: [{ id: 'p0', name: '长链断链', note: '', createdAt: 1 }], records };
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.BROKEN);
  assert.strictEqual(results[0].conflict.minute, 9);
  assert.strictEqual(results[0].conflict.holder, `甲${K}`);
  // 断链仍返回当分钟全部未执行记录（按记录顺序），之后分钟的记录不在其列
  assert.deepStrictEqual(results[0].conflict.records, ['rb1', 'rb2', 'rb3']);
  assert.deepStrictEqual(
    results[0].conflict.recordRefs.map((r) => r.id),
    ['rb1', 'rb2', 'rb3']
  );
  // 冲突前链完整保留且顺序不变
  assert.strictEqual(results[0].chain.length, K);
  assert.strictEqual(results[0].replayedCount, K);
  assert.strictEqual(results[0].totalCount, K + 4);
  assert.strictEqual(results[0].holder, `甲${K}`);
});

// 18. 盘点依赖（holdingsAt）：同分钟长链全部归约后才取账面持有人
test('holdingsAt：同分钟长链重放后取账面持有人，截止分钟前仍在仓库', () => {
  const N = 3000;
  const records = [];
  // 同分钟长链：仓库->甲1->...->甲3000（未归仓）
  for (let k = N - 1; k >= 0; k--) {
    records.push({
      id: `r${k}`,
      propId: 'p0',
      minute: 5,
      from: k === 0 ? WAREHOUSE : `甲${k}`,
      to: `甲${k + 1}`,
      note: '',
      createdAt: t(k),
    });
  }
  // 另一件道具同分钟归仓链，交叉验证多道具互不影响
  records.push({ id: 's1', propId: 'p1', minute: 5, from: WAREHOUSE, to: '乙', note: '', createdAt: t(N) });
  records.push({ id: 's2', propId: 'p1', minute: 5, from: '乙', to: WAREHOUSE, note: '', createdAt: t(N + 1) });
  const data = {
    props: [
      { id: 'p0', name: '长链未归仓', note: '', createdAt: 1 },
      { id: 'p1', name: '同分钟归仓', note: '', createdAt: 2 },
    ],
    records,
  };
  const at5 = holdingsAt(data, 5);
  assert.strictEqual(at5.get('p0').holder, `甲${N}`);
  assert.strictEqual(at5.get('p0').conflict, null);
  assert.strictEqual(at5.get('p1').holder, WAREHOUSE);
  // 盘点分钟早于交接分钟：长链不参与，仍在仓库
  const at4 = holdingsAt(data, 4);
  assert.strictEqual(at4.get('p0').holder, WAREHOUSE);
  assert.strictEqual(at4.get('p1').holder, WAREHOUSE);
});

console.log(`\n全部 ${passed} 个测试通过 ✔`);
