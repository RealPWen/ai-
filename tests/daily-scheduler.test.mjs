import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyScheduler, nextDailyRunAt } from '../backend/market-data/daily-scheduler.mjs';

function clock(initial) {
  let current = new Date(initial).getTime();
  let id = 0;
  const tasks = new Map();
  return {
    now: () => new Date(current),
    setTimeoutImpl(callback, delay) { tasks.set(++id, { callback, at: current + delay, delay }); return id; },
    clearTimeoutImpl(key) { tasks.delete(key); },
    jump(instant) { current = new Date(instant).getTime(); },
    fire() {
      const task = [...tasks.entries()].find(([, value]) => value.at <= current);
      assert.ok(task, '应存在到期的心跳');
      tasks.delete(task[0]);
      task[1].callback();
    },
    get pending() { return [...tasks.values()]; },
  };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('北京时间日界线与闰年不依赖主机时区', () => {
  assert.equal(nextDailyRunAt(new Date('2026-10-14T21:59:59Z')), '2026-10-14T22:00:00.000Z');
  assert.equal(nextDailyRunAt(new Date('2026-10-14T22:00:00Z')), '2026-10-14T22:00:00.000Z');
  assert.equal(nextDailyRunAt(new Date('2026-10-14T22:00:01Z')), '2026-10-15T22:00:00.000Z');
  assert.equal(nextDailyRunAt(new Date('2024-02-28T23:00:00Z')), '2024-02-29T22:00:00.000Z');
  assert.equal(nextDailyRunAt(new Date('2026-12-31T23:00:00Z')), '2027-01-01T22:00:00.000Z');
});

test('六点前启动不执行，到六点执行一次，重复 start 不增加定时器', async () => {
  const time = clock('2026-10-14T21:59:59Z'), calls = [];
  const scheduler = createDailyScheduler({ ...time, run: value => calls.push(value) });
  scheduler.start(); scheduler.start();
  assert.equal(calls.length, 0); assert.equal(time.pending.length, 1);
  assert.equal(time.pending[0].delay, 1000);
  time.jump('2026-10-14T22:00:00Z'); time.fire(); await settle();
  assert.deepEqual(calls, [{ runDate: '2026-10-15', trigger: 'scheduled' }]);
  assert.equal(scheduler.nextRunAt, '2026-10-15T22:00:00.000Z');
  time.jump('2026-10-14T23:00:00Z'); time.fire(); await settle();
  assert.equal(calls.length, 1);
  scheduler.stop(); assert.equal(time.pending.length, 0); assert.equal(scheduler.nextRunAt, null);
});

test('六点整启动执行 scheduled，六点后启动只补跑一次', async () => {
  for (const [instant, trigger] of [['2026-10-14T22:00:00Z', 'scheduled'], ['2026-10-14T23:01:00Z', 'catch_up']]) {
    const time = clock(instant), calls = [];
    const scheduler = createDailyScheduler({ ...time, run: value => calls.push(value) });
    scheduler.start(); await settle();
    assert.deepEqual(calls, [{ runDate: '2026-10-15', trigger }]);
    scheduler.stop(); scheduler.start(); await settle();
    assert.equal(calls.length, 1);
    scheduler.stop();
  }
});

test('关闭启动补跑后，仍然在次日六点触发', async () => {
  const time = clock('2026-10-14T23:00:00Z'), calls = [];
  const scheduler = createDailyScheduler({ ...time, run: value => calls.push(value), catchUp: false });
  scheduler.start(); assert.equal(calls.length, 0);
  time.jump('2026-10-15T22:00:00Z'); time.fire(); await settle();
  assert.deepEqual(calls, [{ runDate: '2026-10-16', trigger: 'scheduled' }]);
  scheduler.stop();
});

test('休眠跨过六点后按当前北京时间运行，心跳不超过一分钟', async () => {
  const time = clock('2026-10-14T21:50:30Z'), calls = [];
  const scheduler = createDailyScheduler({ ...time, run: value => calls.push(value) });
  scheduler.start(); assert.equal(time.pending[0].delay, 60_000);
  time.jump('2026-10-15T00:30:00Z'); time.fire(); await settle();
  assert.deepEqual(calls, [{ runDate: '2026-10-15', trigger: 'scheduled' }]);
  assert.ok(time.pending.every(value => value.delay <= 60_000));
  scheduler.stop();
});

test('更新运行中不重叠；跨日后上一次完成才执行新日期', async () => {
  const time = clock('2026-10-14T22:00:00Z'), calls = [];
  let resolve;
  const scheduler = createDailyScheduler({ ...time, run: value => {
    calls.push(value); return calls.length === 1 ? new Promise(done => { resolve = done; }) : undefined;
  } });
  scheduler.start(); assert.equal(scheduler.running, true);
  time.jump('2026-10-15T23:00:00Z'); time.fire();
  assert.equal(calls.length, 1);
  resolve(); await settle(); assert.equal(scheduler.running, false);
  time.jump('2026-10-15T23:01:00Z'); time.fire(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].runDate, '2026-10-16');
  scheduler.stop();
});

test('停止后清除心跳，进行中的任务完成也不会重启调度', async () => {
  const time = clock('2026-10-14T23:00:00Z');
  let resolve;
  const scheduler = createDailyScheduler({ ...time, run: () => new Promise(done => { resolve = done; }) });
  scheduler.start(); assert.equal(scheduler.running, true);
  scheduler.stop(); assert.equal(time.pending.length, 0);
  resolve(); await settle();
  assert.equal(scheduler.running, false); assert.equal(time.pending.length, 0);
});

test('同步及异步失败只记录安全类别，不在同一天反复执行；次日继续', async () => {
  for (const asynchronous of [false, true]) {
    const time = clock('2026-10-14T23:00:00Z'), logs = [];
    let calls = 0;
    const scheduler = createDailyScheduler({ ...time, log: value => logs.push(value), run: () => {
      calls += 1;
      const error = new Error('secret-token-and-private-url'); error.kind = asynchronous ? 'network' : 'untrusted-secret';
      if (asynchronous) return Promise.reject(error);
      throw error;
    } });
    scheduler.start(); await settle(); assert.equal(scheduler.running, false);
    time.jump('2026-10-15T00:00:00Z'); time.fire(); await settle(); assert.equal(calls, 1);
    time.jump('2026-10-15T22:00:00Z'); time.fire(); await settle(); assert.equal(calls, 2);
    assert.equal(logs.find(value => value.event === 'daily_update_failed').kind, asynchronous ? 'network' : 'unknown');
    assert.equal(JSON.stringify(logs).includes('secret'), false);
    scheduler.stop();
  }
});

test('时钟回拨不重复已完成日期；日志异常不会中止心跳', async () => {
  const time = clock('2026-10-14T23:00:00Z'); let calls = 0;
  const scheduler = createDailyScheduler({ ...time, run: () => { calls += 1; }, log: () => { throw new Error('日志错误'); } });
  scheduler.start(); await settle();
  time.jump('2026-10-15T23:00:00Z'); time.fire(); await settle();
  time.jump('2026-10-14T23:00:00Z');
  scheduler.stop(); scheduler.start(); await settle();
  assert.equal(calls, 2); assert.equal(time.pending.length, 1);
  scheduler.stop();
});

test('拒绝无效配置', () => {
  assert.throws(() => createDailyScheduler(), /更新函数/);
  assert.throws(() => createDailyScheduler({ run() {}, hour: 24 }), /小时/);
  assert.throws(() => createDailyScheduler({ run() {}, heartbeatMs: 60_001 }), /检测间隔/);
  assert.throws(() => nextDailyRunAt(new Date('invalid')), /时间无效/);
});
