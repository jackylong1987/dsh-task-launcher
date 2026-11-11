#!/usr/bin/env node
/**
 * dsh-task-launcher 确认单纯函数的离线用例（不连宿主，不需要 DSH 在跑）。
 * 用法：node test/confirm-board.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

// 桩：把 window.__ModuleLoader__.load 收下来，拿到 exports.__test__
let mod = null
const stubWindow = {
  __ModuleLoader__: { load: (definition) => { mod = definition.factory(makeRequire()) } },
}
const makeRequire = () => (name) => {
  if (name === 'react') {
    const React = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Fragment: 'f' }
    return React
  }
  if (name === 'react-dom') return { createPortal: () => null, createRoot: () => ({ render: () => {}, unmount: () => {} }) }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
  return {}
}

// 执行源码（它只读 window，不碰 DOM 到解析阶段）
const fn = new Function('window', 'document', src)
fn(stubWindow, { querySelector: () => null, createElement: () => ({ style: {}, setAttribute: () => {} }), head: { appendChild: () => {} }, body: { appendChild: () => {} } })

const T = mod.__test__
if (!T) { console.error('FAIL: 没拿到 __test__'); process.exit(1) }

let pass = 0
let fail = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { pass += 1; console.log('  ok   ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + '\n    got ' + a + '\n    want ' + b) }
}

console.log('parseBoard')
eq('空串 ⇒ 失败', T.parseBoard('').ok, false)
eq('坏 JSON ⇒ bad-json', T.parseBoard('{oops').error, 'bad-json')
eq('缺 items ⇒ bad-shape', T.parseBoard('{"a":1}').error, 'bad-shape')
const good = T.parseBoard(JSON.stringify({
  batch: { label: '11-11 13:05 交接' },
  items: [
    { id: 'a', title: '甲', hint: 'h', decision: 'run' },
    { id: 'b', title: '乙', decision: 'weird' },
    { id: '', title: '缺 id' },
    { id: 'c' },
    null,
  ],
}))
eq('坏条目被丢', good.items.length, 2)
eq('认不出 ⇒ none', good.items[1].decision, 'none')
eq('batch 取到', good.batch, '11-11 13:05 交接')

console.log('normalizeChoice')
eq('run', T.normalizeChoice('run'), 'run')
eq('RUN 大写', T.normalizeChoice('RUN'), 'run')
eq('defer', T.normalizeChoice(' defer '), 'defer')
eq('skip', T.normalizeChoice('skip'), 'skip')
eq('乱七八糟 ⇒ none', T.normalizeChoice('maybe'), 'none')
eq('null ⇒ none', T.normalizeChoice(null), 'none')

console.log('boardCounts')
const items = [
  { id: 'a', title: '甲', hint: '', risk: '', decision: 'run' },
  { id: 'b', title: '乙', hint: '', risk: '', decision: 'defer' },
  { id: 'c', title: '丙', hint: '', risk: '', decision: 'skip' },
  { id: 'd', title: '丁', hint: '', risk: '', decision: 'none' },
]
eq('原始计数', T.boardCounts(items, {}), { run: 1, defer: 1, skip: 1, none: 1, total: 4, done: 0, archived: 0 })
eq('覆盖后计数', T.boardCounts(items, { a: 'skip', d: 'run' }), { run: 1, defer: 1, skip: 2, none: 0, total: 4, done: 0, archived: 0 })

console.log('终态（done / archived）')
const closed = T.parseBoard(JSON.stringify({
  items: [
    { id: 'x', title: '已完成项', decision: 'done' },
    { id: 'y', title: '归档项', decision: 'ARCHIVED' },
    { id: 'z', title: '暂缓项', decision: 'defer' },
  ],
}))
eq('done ⇒ state=done', closed.items[0].state, 'done')
eq('done 不可选（decision=none）', closed.items[0].decision, 'none')
eq('archived 大小写无关', closed.items[1].state, 'archived')
eq('open 保留原档', closed.items[2].state, 'open')
eq('终态单列计数、不进 total', T.boardCounts(closed.items, {}), { run: 0, defer: 1, skip: 0, none: 0, total: 1, done: 1, archived: 1 })
eq('终态不参与投递', T.boardPrompt(closed.items, { x: 'run', y: 'run', z: 'defer' }, {}), '')

console.log('boardPrompt')
const text = T.boardPrompt(items, { a: 'run', d: 'run' }, { batch: 'B1' })
eq('有执行 ⇒ 非空', text !== '', true)
eq('含批次', text.includes('B1'), true)
eq('执行两条', text.includes('1. 甲') && text.includes('2. 丁'), true)
eq('暂缓段', text.includes('暂缓') && text.includes('- 乙'), true)
eq('归档段', text.includes('归档') && text.includes('- 丙'), true)
eq('提示回写文件', text.includes('dsh-confirm-board.json'), true)
eq('零执行 ⇒ 空串', T.boardPrompt(items, { a: 'skip', b: 'skip', c: 'skip', d: 'skip' }, {}), '')

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
