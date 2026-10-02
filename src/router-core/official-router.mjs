import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { prepareRoute, resolveSelection, historyDiagnostics, textDiagnostics } from './dual-route-policy.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const MAX_EVENT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);

function safeRecord(callback, record) {
  try { Promise.resolve(callback(record)).catch(() => {}); } catch { /* evidence failures never change enforcement */ }
}

function deny(res, status, code) {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: code }));
  } else res.destroy();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body_limit')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('cancelled')));
  });
}

function parseEvent(block) {
  let event = '';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  let payload;
  if (data.length) {
    try { payload = JSON.parse(data.join('\n')); } catch { /* invalid terminal data is rejected below */ }
  }
  if (!event && typeof payload?.type === 'string') event = payload.type;
  if (terminal.has(event) && (payload?.type !== event || !payload || Array.isArray(payload))) {
    throw new Error('invalid_terminal_event');
  }
  return event;
}

export function createOfficialRouter({ ingressToken, boundThreadId, expiresAt = null, maxRequests = expiresAt === null ? null : 6, transport, now = Date.now, onRecord = () => {}, requestTimeoutMs = 300_000, firstByteTimeoutMs = requestTimeoutMs, streamIdleTimeoutMs = requestTimeoutMs, companyToken, routeMode = 'legacy', companyReasoningApproval, companyToolsApproval, diagnosticsOnly = false, lifecycle = 'pilot', nativeCompanyThreadId, officialModels = [], resolveCompanyRoute }) {
  const startedAt = now();
  const continuous = lifecycle === 'continuous';
  const unlimited = expiresAt === null && maxRequests === null;
  const expired = () => expiresAt !== null && now() >= expiresAt;
  if (!['pilot', 'continuous'].includes(lifecycle) ||
      (resolveCompanyRoute !== undefined && (typeof resolveCompanyRoute !== 'function' || routeMode !== 'self' || !continuous || nativeCompanyThreadId !== boundThreadId)) ||
      (continuous && (typeof boundThreadId !== 'string' || !UUID.test(boundThreadId))) ||
      (nativeCompanyThreadId !== undefined && (!continuous || routeMode !== 'self' || nativeCompanyThreadId !== boundThreadId)) ||
      !Array.isArray(officialModels) || officialModels.some(model => typeof model !== 'string' || !model || model.endsWith('_self')) ||
      typeof diagnosticsOnly !== 'boolean' || !['legacy', 'self'].includes(routeMode) || typeof ingressToken !== 'string' || !ingressToken ||
      !(typeof boundThreadId === 'function' || (typeof boundThreadId === 'string' && boundThreadId)) ||
      (!unlimited && (!Number.isFinite(expiresAt) || expiresAt <= startedAt || expiresAt - startedAt > (continuous ? 120 : 30) * 60_000 ||
      !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > (continuous ? 100 : 6))) ||
      typeof transport !== 'function' || typeof now !== 'function' || typeof onRecord !== 'function' ||
      (companyToken !== undefined && (typeof companyToken !== 'string' || !/^\S+$/.test(companyToken))) ||
      [requestTimeoutMs, firstByteTimeoutMs, streamIdleTimeoutMs].some(ms => !Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647)) {
    throw new TypeError('invalid_router_configuration');
  }

  let outboundCount = 0;
  let stopped = false;
  let active = null;
  let lastCode = 'ready';
  const reasoningApproval = companyReasoningApproval ? Object.freeze({ ...companyReasoningApproval }) : undefined;
  const toolsApproval = companyToolsApproval ? Object.freeze({ ...companyToolsApproval }) : undefined;
  const officialAllowlist = Object.freeze([...officialModels]);
  let expiryTimer;
  const emit = (stage, code, fields = {}) => {
    lastCode = code;
    safeRecord(onRecord, {
      stage, code, model: fields.model ?? null, upstreamModel: fields.upstreamModel ?? null, route: fields.route ?? null, threadId: fields.threadId ?? null,
      turnId: fields.turnId ?? null, upstreamStatus: fields.upstreamStatus ?? null,
      hasAuthorization: fields.hasAuthorization ?? false,
      hasAccountId: fields.hasAccountId ?? false,
      ...(fields.eventBytes !== undefined ? { eventBytes: fields.eventBytes, eventLimitBytes: MAX_EVENT } : {}),
      ...(fields.historyDiagnostics ? { historyDiagnostics: fields.historyDiagnostics } : {}),
      ...(fields.textDiagnostics ? { textDiagnostics: fields.textDiagnostics } : {}),
      outboundCount, timestamp: now(),
    });
  };
  const halt = (code) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(expiryTimer);
    active?.abort(code);
    emit('stopped', code);
  };
  const failRequest = code => { if (!continuous) halt(code); };
  if (!unlimited) {
    expiryTimer = setTimeout(() => halt('expired'), Math.max(0, expiresAt - now()));
    expiryTimer.unref?.();
  }

  async function handle(req, res) {
    // Rejected ingress is not itself a failed bound-task model call.
    const rejectIngress = (status, code) => { emit('ingress_rejected', code); deny(res, status, 'request_rejected'); };
    if (stopped || expired()) { if (!stopped) halt('expired'); deny(res, continuous && expired() ? 410 : 403, continuous && expired() ? 'router_expired' : 'router_stopped'); return; }
    if (req.method !== 'POST') { rejectIngress(403, 'METHOD_REJECTED'); return; }
    if (req.url !== '/v1/responses') { rejectIngress(403, 'PATH_REJECTED'); return; }
    if (req.headers.origin !== undefined) { rejectIngress(403, 'ORIGIN_REJECTED'); return; }
    const provided = req.headers['x-worker-router-token'];
    const expected = Buffer.from(ingressToken);
    const actual = Buffer.from(typeof provided === 'string' ? provided : '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { rejectIngress(403, 'INGRESS_TOKEN_REJECTED'); return; }
    if (active) { deny(res, 409, 'router_busy'); return; }
    const authorization = req.headers.authorization;
    const accountId = req.headers['chatgpt-account-id'];
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization) || typeof accountId !== 'string' || !accountId.trim()) { rejectIngress(403, 'OFFICIAL_AUTH_REJECTED'); return; }
    let metadata;
    let body;
    try {
      metadata = JSON.parse(req.headers['x-codex-turn-metadata']);
      body = await readBody(req);
    } catch { rejectIngress(400, 'METADATA_OR_BODY_REJECTED'); return; }
    let payload;
    try { payload = JSON.parse(body); } catch { rejectIngress(400, 'JSON_REJECTED'); return; }
    let threadId;
    try { threadId = typeof boundThreadId === 'function' ? boundThreadId() : boundThreadId; }
    catch { rejectIngress(403, 'THREAD_BINDING_UNAVAILABLE'); return; }
    if (!threadId || !UUID.test(threadId) || metadata?.thread_id !== threadId || !UUID.test(metadata?.turn_id ?? '')) {
      rejectIngress(403, 'THREAD_BINDING_REJECTED'); return;
    }
    let selection, companySnapshot;
    try {
      if (resolveCompanyRoute && typeof payload?.model === 'string' && payload.model.endsWith('_self')) {
        if ((metadata.model !== undefined && metadata.model !== payload.model) || payload.stream !== true) throw Error();
        const route = resolveCompanyRoute({ model: payload.model, threadId, turnId: metadata.turn_id, payload: structuredClone(payload) });
        if (route && typeof route.then === 'function') { Promise.resolve(route).catch(() => {}); throw new Error('SYNC_ROUTE_REQUIRED'); }
        const url = new URL(route.responsesUrl);
        if (typeof route.upstreamModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(route.upstreamModel) ||
            typeof route.companyToken !== 'string' || !/^[\x21-\x7e]+$/.test(route.companyToken) ||
            (url.protocol !== 'https:' && !(url.protocol === 'http:' && route.allowHttp === true)) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/responses')) throw Error();
        companySnapshot = Object.freeze({ upstreamModel: route.upstreamModel, companyToken: route.companyToken, responsesUrl: url.href });
        selection = { route: 'company', upstreamModel: companySnapshot.upstreamModel };
      } else {
        // Registry-backed services must not inherit the pilot's fixed models.
        if (resolveCompanyRoute && !officialAllowlist.includes(payload?.model)) throw Error();
        selection = resolveSelection(payload?.model, routeMode, officialAllowlist);
      }
    } catch { /* fail closed; never use legacy company credentials on resolver failure */ }
    if ((metadata.model !== undefined && metadata.model !== payload?.model) ||
        !selection || (selection.route === 'company' && !companySnapshot && companyToken === undefined) || payload.stream !== true) {
      emit('rejected', 'BOUND_REQUEST_REJECTED', { threadId, turnId: metadata.turn_id });
      failRequest('BOUND_REQUEST_REJECTED'); deny(res, 403, 'request_rejected'); return;
    }
    let prepared;
    try { prepared = prepareRoute(body, req.headers, companySnapshot?.companyToken ?? companyToken, routeMode,
      reasoningApproval?.threadId === threadId ? reasoningApproval : undefined,
      toolsApproval?.threadId === threadId ? toolsApproval : undefined,
      { officialModels: officialAllowlist, nativeCompany: nativeCompanyThreadId === threadId, companySelection: companySnapshot ? selection : undefined }); }
    catch (error) {
      const code = ['HISTORY_NOT_PORTABLE', 'TEXT_PILOT_ONLY', 'MISSING_CALL_ID', 'INVALID_NATIVE_INPUT'].includes(error.message) ? error.message : 'request_rejected';
      emit('rejected', code, { threadId, turnId: metadata.turn_id, model: payload.model,
        route: selection.route, upstreamModel: selection.upstreamModel,
        ...(['HISTORY_NOT_PORTABLE', 'TEXT_PILOT_ONLY', 'MISSING_CALL_ID'].includes(code) ? {
          historyDiagnostics: historyDiagnostics(payload, reasoningApproval?.threadId === threadId ? reasoningApproval : undefined, selection.upstreamModel),
          textDiagnostics: textDiagnostics(payload, reasoningApproval?.threadId === threadId ? reasoningApproval : undefined, selection.upstreamModel),
        } : {}) });
      failRequest(code);
      deny(res, 400, code); return;
    }
    if (diagnosticsOnly) {
      emit('diagnostic', 'DIAGNOSTICS_ONLY_NO_UPSTREAM', { threadId, turnId: metadata.turn_id, model: payload.model,
        route: selection.route, upstreamModel: selection.upstreamModel });
      halt('DIAGNOSTICS_ONLY_NO_UPSTREAM'); deny(res, 409, 'DIAGNOSTICS_ONLY_NO_UPSTREAM'); return;
    }
    if (stopped || expired()) { if (!stopped) halt('expired'); deny(res, continuous && expired() ? 410 : 403, continuous && expired() ? 'router_expired' : 'router_stopped'); return; }
    if (active) { deny(res, 409, 'router_busy'); return; }
    if (!unlimited && outboundCount >= maxRequests) { deny(res, 429, 'budget_exhausted'); return; }

    const controller = new AbortController();
    active = controller;
    outboundCount++;
    const fields = { threadId, turnId: metadata.turn_id, model: payload.model, upstreamModel: prepared.upstreamModel, route: prepared.route, hasAuthorization: true, hasAccountId: prepared.route === 'official' };
    emit('reserved', 'outbound_reserved', fields);
    const headers = prepared.headers;
    let timeout;
    let reader;
    let upstreamStatus = null;
    let eventBytes = 0;
    let completedRecorded = false;
    const abortOnDisconnect = () => { if (!res.writableEnded) controller.abort('cancelled'); };
    res.once('close', abortOnDisconnect);
    const abortPromise = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    // Headers alone are not progress. Once bytes arrive, only an idle gap times out;
    // a healthy stream has no total wall-clock deadline.
    let timeoutPhase = 'first_byte_timeout';
    const armTimeout = (ms, phase) => {
      clearTimeout(timeout);
      timeoutPhase = phase;
      timeout = setTimeout(() => controller.abort('timeout'), ms);
      timeout.unref?.();
    };
    armTimeout(firstByteTimeoutMs, 'first_byte_timeout');
    try {
      const upstream = await Promise.race([transport({ headers, body: prepared.body, route: prepared.route, signal: controller.signal, ...(companySnapshot ? { responsesUrl: companySnapshot.responsesUrl } : {}) }), abortPromise]);
      if (!(upstream instanceof Response)) throw new Error('transport_response');
      upstreamStatus = upstream.status;
      emit('upstream', 'upstream_headers_received', { ...fields, upstreamStatus });
      if (!upstream.ok) { emit('upstream', 'upstream_http_error', { ...fields, upstreamStatus: upstream.status }); failRequest('upstream_http_error'); await upstream.body?.cancel(); deny(res, 502, continuous ? `upstream_http_${upstream.status}` : 'upstream_failed'); return; }
      if (!upstream.body) throw new Error('empty_stream');
      reader = upstream.body.getReader();
      controller.signal.addEventListener('abort', () => { reader?.cancel().catch(() => {}); }, { once: true });
      res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      let buffer = '';
      let complete = false;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await Promise.race([reader.read(), abortPromise]);
        if (done) break;
        if (value.byteLength > 0) armTimeout(streamIdleTimeoutMs, 'stream_idle_timeout');
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, boundary);
          // Network chunks may contain many events; enforce the limit per event.
          eventBytes = Buffer.byteLength(block);
          if (eventBytes > MAX_EVENT) throw new Error('event_limit');
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const event = parseEvent(block);
          if (complete && event && event !== 'response.completed') throw new Error('event_after_terminal');
          if (terminal.has(event)) {
            if (event !== 'response.completed') throw new Error('upstream_event');
            complete = true;
          }
        }
        eventBytes = Buffer.byteLength(buffer);
        if (eventBytes > MAX_EVENT) throw new Error('event_limit');
        if (complete) {
          if (controller.signal.aborted) throw new Error('aborted_before_terminal');
          emit('upstream', 'response_completed', { ...fields, upstreamStatus: upstream.status });
          completedRecorded = true;
        }
        if (!res.write(value)) await Promise.race([once(res, 'drain'), abortPromise]);
        if (complete) {
          res.end();
          return;
        }
      }
      throw new Error('incomplete_stream');
    } catch (error) {
      const reason = controller.signal.aborted ? String(controller.signal.reason) : 'upstream_failed';
      if(reason==='local_storage_failed'||error?.message==='BUDGET_WRITE_FAILED'){
        halt('local_storage_failed');
        emit('failure','local_storage_failed',fields);
        deny(res,503,'local_storage_failed');
        return;
      }
      if (!completedRecorded) {
        const safeErrors = ['transport_response', 'empty_stream', 'event_limit', 'invalid_terminal_event', 'event_after_terminal', 'upstream_event', 'incomplete_stream', 'aborted_before_terminal'];
        const code = controller.signal.aborted
          ? (['expired', 'timeout', 'cancelled', 'stopped'].includes(reason) ? reason : 'aborted')
          : (safeErrors.includes(error?.message) ? error.message : 'transport_or_stream_error');
        emit('failure', code === 'timeout' ? timeoutPhase : code, { ...fields, upstreamStatus, ...(code === 'event_limit' ? { eventBytes } : {}) });
        failRequest(['expired', 'timeout', 'cancelled', 'stopped'].includes(reason) ? reason : 'upstream_failed');
        deny(res, 502, 'upstream_failed');
      } else if (!res.destroyed && !res.writableEnded) res.destroy();
    } finally {
      clearTimeout(timeout);
      res.off('close', abortOnDisconnect);
      if (active === controller) active = null;
      if (reader) {
        try { await reader.cancel(); } catch { /* cleanup must not alter the recorded outcome */ }
        reader.releaseLock();
      }
    }
  }

  return {
    handle,
    snapshot: () => ({ stopped, active: active !== null, outboundCount, maxRequests, expiresAt, lastCode, lifecycle }),
    stop: (reason) => halt(reason==='local_storage_failed'?'local_storage_failed':'stopped'),
  };
}
