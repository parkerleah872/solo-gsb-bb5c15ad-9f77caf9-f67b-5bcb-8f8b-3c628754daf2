import React, { useRef, useState } from 'react';
import { api } from '../api';

/**
 * 输入日志诊断（只读报告页）：
 * - 导入/粘贴按时间排序的按键事件日志（每事件：上下文 ID + 按键 + 相对毫秒）；
 * - 后端校验上下文存在、时间单调不减、按键格式，按连续相同上下文切段，
 *   每段以首键为时间原点复用时序回放规则（切换上下文即结束上一段待定状态）；
 * - 页面按原始事件顺序展示各段的触发命令、超时与未命中事件，
 *   并汇总各命令触发次数与各上下文未命中次数；
 * - 校验失败返回出错事件位置，不生成部分报告；本页不修改任何数据。
 */

const PLACEHOLDER = `{
  "timeoutMs": 800,
  "events": [
    { "contextId": "ctx-code", "key": "g", "timeMs": 0 },
    { "contextId": "ctx-code", "key": "d", "timeMs": 300 },
    { "contextId": "ctx-terminal", "key": "g", "timeMs": 1200 }
  ]
}`;

function StatCard({ value, label, tone = '' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 单个上下文段：触发命令 / 超时事件 / 未命中事件（段内时刻以首键为原点） */
function SegmentCard({ segment }) {
  const { replay } = segment;
  const fired = replay.fired; // [{ atMs, eventType, commands }]
  const timeouts = replay.events.filter((e) => e.type === 'timeout');
  const misses = replay.events.filter((e) => e.status === 'no-match');
  const lastEvent = segment.startEventIndex + segment.eventCount - 1;

  return (
    <div className="suite-case">
      <div className="suite-case-head">
        <span className="suite-index">段 #{segment.index + 1}</span>
        <strong className="suite-path" title={segment.contextPath}>
          {segment.contextPath}
        </strong>
        <span className="dim small">
          原始事件 #{segment.startEventIndex + 1}–#{lastEvent + 1}（{segment.eventCount} 键） · 原始时刻{' '}
          {segment.startMs}–{segment.endMs}ms · 段内以首键为时间原点
        </span>
      </div>

      <div className="log-seg-body">
        <div className="log-seg-col">
          <h5>⚡ 触发命令（{fired.reduce((n, f) => n + f.commands.length, 0)}）</h5>
          {fired.length === 0 ? (
            <p className="hint small">本段没有触发任何命令。</p>
          ) : (
            <ul className="log-evt-list">
              {fired.map((f, i) =>
                f.commands.map((c) => (
                  <li key={`${i}-${c.commandId}`}>
                    <span className="fired-at">@{f.atMs}ms</span>
                    <strong>{c.name}</strong>
                    <kbd>{c.sequenceLabel}</kbd>
                    <span className="party-source">
                      {f.eventType === 'timeout' ? '超时触发' : '按键触发'} · 来源：{c.contextPath}
                    </span>
                    {c.duplicate && <span className="badge duplicate">同层重复</span>}
                  </li>
                )),
              )}
            </ul>
          )}
        </div>

        <div className="log-seg-col">
          <h5>⏰ 超时事件（{timeouts.length}）</h5>
          {timeouts.length === 0 ? (
            <p className="hint small">本段没有待定超时。</p>
          ) : (
            <ul className="log-evt-list">
              {timeouts.map((ev) => (
                <li key={ev.seq}>
                  <span className="fired-at">@{ev.timeMs}ms</span>
                  <span className="timeout-tag">⏰ 超时</span>
                  <kbd>{ev.bufferLabel}</kbd>
                  <span className="party-source">超过 {ev.timeoutMs}ms 未续键，触发待定短序列</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="log-seg-col">
          <h5>❌ 未命中事件（{misses.length}）</h5>
          {misses.length === 0 ? (
            <p className="hint small">本段没有未命中按键。</p>
          ) : (
            <ul className="log-evt-list">
              {misses.map((ev) => (
                <li key={ev.seq}>
                  <span className="fired-at">@{ev.timeMs}ms</span>
                  <kbd className="press">{ev.pretty}</kbd>
                  <span className="party-source">
                    原始事件 #{ev.eventIndex + 1} · 无任何匹配序列，已丢弃并重新起算
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LogDiagnosis() {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [errorIndex, setErrorIndex] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const fileRef = useRef(null);

  const showError = (err) => {
    setResult(null);
    setError(err.message);
    const idx = err.details && Number.isInteger(err.details.eventIndex) ? err.details.eventIndex : null;
    setErrorIndex(idx);
  };

  const run = async (body) => {
    setLoading(true);
    try {
      const r = await api.logDiagnosis(body);
      setResult(r);
      setError('');
      setErrorIndex(null);
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
    }
  };

  const diagnose = () => {
    let body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      setResult(null);
      setError(`日志 JSON 解析失败：${err.message}`);
      setErrorIndex(null);
      return;
    }
    run(body);
  };

  const loadSample = async () => {
    setLoading(true);
    try {
      const sample = await api.logDiagnosisSample();
      setText(JSON.stringify(sample, null, 2));
      await run(sample);
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
    }
  };

  const downloadSample = async () => {
    try {
      downloadJson(await api.logDiagnosisSample(), 'log-sample.json');
    } catch (err) {
      showError(err);
    }
  };

  const importFile = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result || ''));
      setError('');
      setErrorIndex(null);
    };
    reader.onerror = () => setError('读取文件失败');
    reader.readAsText(file);
  };

  return (
    <div className="regression-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>📄 输入日志诊断</h2>
          <span className="dim small">
            只读诊断：按连续相同上下文切段，每段以首键为时间原点复用时序回放规则；切换上下文即结束上一段待定状态
            {result ? ` · 数据时间：${new Date(result.generatedAt).toLocaleString()}` : ''}
          </span>
        </div>
        <div className="regression-actions">
          <button onClick={() => fileRef.current?.click()}>⇧ 导入日志 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
          <button onClick={loadSample} disabled={loading} title="按当前数据生成示例日志并立即诊断">
            载入示例并诊断
          </button>
          <button onClick={downloadSample} title="下载按当前数据生成的示例日志">
            ⇩ 示例日志
          </button>
          <button
            className="primary"
            onClick={() => result && downloadJson(result, 'log-diagnosis-result.json')}
            disabled={!result}
          >
            下载结果 JSON
          </button>
        </div>
      </div>

      <div className="log-editor">
        <textarea
          className="log-textarea"
          spellCheck={false}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="log-editor-bar">
          <span className="hint small">
            每个事件需给出 contextId（上下文 ID）、key（按键，支持 Ctrl+K 组合键）与 timeMs（相对毫秒，单调不减）；可选
            timeoutMs 逐事件覆盖阈值
          </span>
          <button className="primary" onClick={diagnose} disabled={loading || !text.trim()}>
            {loading ? '诊断中…' : '开始诊断'}
          </button>
        </div>
      </div>

      {error && (
        <p className="error">
          ⚠ {error}
          {errorIndex !== null && <span className="badge duplicate">出错位置：第 {errorIndex + 1} 个事件</span>}
          {errorIndex === null && <span className="dim small">（未生成任何报告）</span>}
        </p>
      )}

      {result && (
        <>
          <div className="stat-grid">
            <StatCard value={result.stats.eventCount} label="日志事件数" />
            <StatCard value={result.stats.segmentCount} label="上下文段数" />
            <StatCard value={result.stats.contextCount} label="涉及上下文" />
            <StatCard value={`${result.stats.durationMs}ms`} label="日志时长" />
            <StatCard
              value={result.stats.triggeredCommandCount}
              label={`命令触发次数（${result.stats.distinctCommandCount} 条不同命令）`}
              tone={result.stats.triggeredCommandCount > 0 ? 'ok' : ''}
            />
            <StatCard
              value={result.stats.timeoutCount}
              label="超时事件"
              tone={result.stats.timeoutCount > 0 ? 'warn' : ''}
            />
            <StatCard
              value={result.stats.missCount}
              label="未命中事件"
              tone={result.stats.missCount > 0 ? 'danger' : ''}
            />
          </div>

          <div className="log-summary">
            <div className="log-summary-col">
              <h3>各命令触发次数（{result.summary.commandTriggers.length} 条命令）</h3>
              {result.summary.commandTriggers.length === 0 ? (
                <p className="hint">整条日志没有触发任何命令。</p>
              ) : (
                <table className="bind-table">
                  <thead>
                    <tr>
                      <th>命令</th>
                      <th>定义位置</th>
                      <th style={{ width: 90 }}>触发次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.summary.commandTriggers.map((c) => (
                      <tr key={c.commandId}>
                        <td>{c.name}</td>
                        <td className="source">{c.contextPath}</td>
                        <td className="log-count">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="log-summary-col">
              <h3>各上下文未命中次数（{result.summary.contextMisses.length} 个上下文）</h3>
              {result.summary.contextMisses.length === 0 ? (
                <p className="hint">整条日志没有未命中事件。</p>
              ) : (
                <table className="bind-table">
                  <thead>
                    <tr>
                      <th>上下文</th>
                      <th style={{ width: 90 }}>未命中次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.summary.contextMisses.map((c) => (
                      <tr key={c.contextId}>
                        <td className="source">{c.contextPath}</td>
                        <td className="log-count">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="suite-cases">
            <h3>
              分段明细（{result.segments.length} 段，按原始事件顺序）
              <span className="dim small">
                {' '}
                段内时刻以该段首键为原点；每个按键事件标注其在原始日志中的位置
              </span>
            </h3>
            {result.segments.map((seg) => (
              <SegmentCard key={seg.index} segment={seg} />
            ))}
          </div>

          <details className="json-details" onToggle={(e) => setShowJson(e.target.open)}>
            <summary>查看完整 JSON（与 POST /api/log-diagnosis 返回内容一致）</summary>
            {showJson && <pre className="json-pre">{JSON.stringify(result, null, 2)}</pre>}
          </details>
        </>
      )}
    </div>
  );
}
