/**
 * 输入日志诊断接口测试（HTTP 级）：
 * - POST /api/log-diagnosis 按连续相同上下文切段并复用时序回放规则，
 *   返回各段触发命令/超时/未命中与汇总（各命令触发次数、各上下文未命中次数）；
 * - 非法输入返回 400 且 details.eventIndex 给出出错事件位置，不生成部分报告；
 * - GET /api/log-diagnosis/sample 生成对当前数据合法的示例日志，可直接诊断；
 * - 诊断与示例均为只读：调用前后状态指纹一致，数据文件内容不变。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-log-diagnosis-test-'));
process.env.DATA_DIR = DATA_DIR;

const { start } = require('../src/index');

let server;
let base;
let passed = 0;

const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const req = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
};

// 演示数据日志：Code Editor（G / G D / G D D 前缀链）与 Terminal（G / G L）两段切换
const LOG = {
  timeoutMs: 800,
  events: [
    { contextId: 'ctx-code', key: 'g', timeMs: 0 }, //      #0 code：G 待定
    { contextId: 'ctx-code', key: 'd', timeMs: 300 }, //    #1 code：G D 待定（仍是 G D D 前缀）
    { contextId: 'ctx-terminal', key: 'g', timeMs: 2000 }, // #2 terminal：G 待定（全新起算）
    { contextId: 'ctx-terminal', key: 'l', timeMs: 2300 }, // #3 terminal：触发 清屏 G L
    { contextId: 'ctx-terminal', key: 'z', timeMs: 2600 }, // #4 terminal：未命中
    { contextId: 'ctx-code', key: 'g', timeMs: 4000 }, //   #5 code：G 待定
    { contextId: 'ctx-code', key: 'd', timeMs: 4100 }, //   #6 code：G D 待定
    { contextId: 'ctx-code', key: 'd', timeMs: 4200 }, //   #7 code：触发 G D D
  ],
};

async function main() {
  ({ server } = await start(0));
  base = `http://127.0.0.1:${server.address().port}`;

  await test('诊断报告：切段、段首时间原点、切换上下文结束待定、汇总统计', async () => {
    const { status, data } = await req('POST', '/api/log-diagnosis', LOG);
    assert.equal(status, 200);
    assert.equal(data.format, 'shortcut-log-diagnosis-v1');
    assert.equal(data.timeoutMs, 800);

    assert.equal(data.stats.eventCount, 8);
    assert.equal(data.stats.segmentCount, 3);
    assert.equal(data.stats.contextCount, 2);
    assert.equal(data.stats.durationMs, 4200);
    assert.equal(data.stats.timeoutCount, 1);
    assert.equal(data.stats.missCount, 1);
    assert.equal(data.stats.triggeredCommandCount, 3);

    // 段 0（Code Editor，事件 #0-#1）：G D 待定，段尾切换上下文时超时结算触发 cmd-11
    const seg0 = data.segments[0];
    assert.equal(seg0.contextId, 'ctx-code');
    assert.equal(seg0.contextPath, 'App / Editor / Code Editor');
    assert.equal(seg0.startEventIndex, 0);
    assert.equal(seg0.eventCount, 2);
    assert.deepEqual([seg0.startMs, seg0.endMs], [0, 300]);
    assert.equal(seg0.replay.events[0].timeMs, 0); // 段首键为时间原点
    assert.equal(seg0.replay.events[0].eventIndex, 0);
    const seg0Timeout = seg0.replay.events.find((e) => e.type === 'timeout');
    assert.ok(seg0Timeout, '段尾应补发超时事件结算待定');
    assert.equal(seg0Timeout.timeMs, 1100); // 段内 300 + 800
    assert.deepEqual(seg0Timeout.triggered.map((c) => c.commandId), ['cmd-11']);

    // 段 1（Terminal，事件 #2-#4）：G 是全新起算（不承接上一段 G D 前缀），G L 触发，Z 未命中
    const seg1 = data.segments[1];
    assert.equal(seg1.contextId, 'ctx-terminal');
    assert.equal(seg1.startEventIndex, 2);
    assert.deepEqual([seg1.startMs, seg1.endMs], [2000, 2600]);
    assert.equal(seg1.replay.events[0].timeMs, 0); // 2000 被平移为段内原点
    assert.equal(seg1.replay.events[0].status, 'pending');
    assert.equal(seg1.replay.events[0].restartFrom, false);
    const glTrigger = seg1.replay.events[1];
    assert.equal(glTrigger.status, 'triggered');
    assert.deepEqual(glTrigger.triggered.map((c) => c.commandId), ['cmd-16']);
    assert.equal(glTrigger.eventIndex, 3);
    const miss = seg1.replay.events[2];
    assert.equal(miss.status, 'no-match');
    assert.equal(miss.eventIndex, 4);

    // 段 2（Code Editor，事件 #5-#7）：G D D 完整触发
    const seg2 = data.segments[2];
    assert.equal(seg2.contextId, 'ctx-code');
    assert.equal(seg2.startEventIndex, 5);
    const gdd = seg2.replay.events[2];
    assert.equal(gdd.status, 'triggered');
    assert.deepEqual(gdd.triggered.map((c) => c.commandId), ['cmd-12']);

    // 汇总：各命令触发次数、各上下文未命中次数
    const triggers = Object.fromEntries(data.summary.commandTriggers.map((c) => [c.commandId, c.count]));
    assert.deepEqual(triggers, { 'cmd-11': 1, 'cmd-12': 1, 'cmd-16': 1 });
    assert.deepEqual(data.summary.contextMisses, [
      { contextId: 'ctx-terminal', contextPath: 'App / Editor / Terminal', count: 1 },
    ]);
  });

  await test('非法输入：返回 400 与出错事件位置，不生成部分报告', async () => {
    const cases = [
      [{ events: [{ contextId: 'ctx-ghost', key: 'g', timeMs: 0 }] }, 0, /上下文不存在/],
      [
        {
          events: [
            { contextId: 'ctx-code', key: 'g', timeMs: 0 },
            { contextId: 'ctx-code', key: 'd', timeMs: 900 },
            { contextId: 'ctx-code', key: 'd', timeMs: 500 }, // 时间倒退
          ],
        },
        2,
        /单调不减/,
      ],
      [
        {
          events: [
            { contextId: 'ctx-code', key: 'g', timeMs: 0 },
            { contextId: 'ctx-code', key: 'ctrl+', timeMs: 100 }, // 按键格式非法
          ],
        },
        1,
        /按键无效/,
      ],
      [{ events: [{ contextId: 'ctx-code', key: 'g', timeMs: -3 }] }, 0, /timeMs/],
      [{ events: [] }, null, /至少需要一个/],
      [{}, null, /events/],
    ];
    for (const [body, eventIndex, pattern] of cases) {
      const { status, data } = await req('POST', '/api/log-diagnosis', body);
      assert.equal(status, 400, JSON.stringify(data));
      assert.match(data.error, pattern);
      if (eventIndex !== null) assert.equal(data.details?.eventIndex, eventIndex);
      // 不生成部分报告：错误响应中不含任何报告字段
      assert.equal(data.segments, undefined);
      assert.equal(data.stats, undefined);
      assert.equal(data.summary, undefined);
    }
  });

  await test('示例日志：对当前数据合法，可直接诊断出多段报告', async () => {
    const sampleRes = await req('GET', '/api/log-diagnosis/sample');
    assert.equal(sampleRes.status, 200);
    assert.ok(Array.isArray(sampleRes.data.events) && sampleRes.data.events.length >= 4);
    const { status, data } = await req('POST', '/api/log-diagnosis', sampleRes.data);
    assert.equal(status, 200, '示例日志必须能通过诊断校验');
    assert.ok(data.stats.segmentCount >= 2);
    assert.ok(data.stats.triggeredCommandCount >= 2);
    assert.ok(data.stats.timeoutCount >= 1);
    assert.ok(data.stats.missCount >= 1);
  });

  await test('支持 ?download=1 附件响应头', async () => {
    const diag = await req('POST', '/api/log-diagnosis?download=1', LOG);
    assert.equal(diag.status, 200);
    assert.match(
      diag.headers.get('content-disposition') || '',
      /attachment; filename="log-diagnosis\.json"/,
    );
    const sample = await req('GET', '/api/log-diagnosis/sample?download=1');
    assert.equal(sample.status, 200);
    assert.match(
      sample.headers.get('content-disposition') || '',
      /attachment; filename="log-sample\.json"/,
    );
  });

  await test('诊断为纯只读：状态指纹与数据文件在调用前后不变', async () => {
    const diskBefore = fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8');
    const fpBefore = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    await req('POST', '/api/log-diagnosis', LOG);
    await req('GET', '/api/log-diagnosis/sample');
    const fpAfter = (await req('POST', '/api/sandbox/preview', {})).data.baselineFingerprint;
    assert.equal(fpAfter, fpBefore);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'), diskBefore);
  });

  console.log(`\n日志诊断接口测试全部通过：${passed} 项`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
